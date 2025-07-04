import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore';
import { getStorage, ref, listAll, getDownloadURL, StorageReference } from 'firebase/storage';

// Main App component
const App = () => {
  // Firebase Configuration - DIRECTED FROM USER INPUT
  const firebaseConfig = {
    apiKey: "AIzaSyD5OeUTAeUoV6zga6wA4xJw0ZmvaJnVb7M",
    authDomain: "flaunt-it.firebaseapp.com",
    projectId: "flaunt-it",
    storageBucket: "flaunt-it.firebasestorage.app",
    messagingSenderId: "653310831467",
    appId: "1:653310831467:web:625becd033f27fc922ba2e",
    measurementId: "G-C8PJ463BVP"
  };

  const initialAuthToken = null; // Force anonymous sign-in

  const currentAppId = firebaseConfig.projectId;

  // Firebase instances
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [storage, setStorage] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [firebaseInitError, setFirebaseInitError] = useState(null);

  // State to store dynamically loaded tattoo image REFERENCES and their metadata
  // Each item: { ref: StorageReference, fullPath: string, category: string }
  const [tattooImagesMetadata, setTattooImagesMetadata] = useState([]);
  // State to store the URL of the CURRENTLY displayed image
  const [currentImageUrl, setCurrentImageUrl] = useState(null);
  // Loading states
  const [metadataLoading, setMetadataLoading] = useState(true); // Loading the list of image references/metadata
  const [currentImageLoading, setCurrentImageLoading] = useState(false); // Loading the current image's URL
  const [imagesError, setImagesError] = useState(null); // Error for image fetching

  // State to keep track of the current image index in the `tattooImagesMetadata` array
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  // State to track if all images have been viewed (in the current cycle)
  const [allImagesViewed, setAllImagesViewed] = useState(false);
  // States to store arrays of liked/disliked image paths
  const [likedImages, setLikedImages] = useState([]);
  const [dislikedImages, setDislikedImages] = useState([]);

  // Recommendation System States
  // Tracks how many times images from a category have been liked
  const [likedCategoriesCount, setLikedCategoriesCount] = useState({}); // e.g., { 'nature': 5, 'animal': 2 }
  // Set of indices of images that have already been shown in the current cycle
  const [unseenImageIndices, setUnseenImageIndices] = useState(new Set());

  // States for swipe animation
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [currentX, setCurrentX] = useState(0);
  const [cardTransform, setCardTransform] = useState('translateX(0px) rotate(0deg)');
  const [cardTransition, setCardCardTransition] = useState('none');
  const cardRef = useRef(null);

  const swipeThreshold = 100;

  // Timer states
  const [timeLeft, setTimeLeft] = useState(60);
  const [timerRunning, setTimerRunning] = useState(true);
  const timerIntervalRef = useRef(null);

  // Modal state
  const [showContactModal, setShowContactModal] = useState(false);
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [submissionCompleted, setSubmissionCompleted] = useState(false);
  const [isSavingData, setIsSavingData] = useState(false);
  const [submissionError, setSubmissionError] = useState('');

  // Validation error states
  const [emailError, setEmailError] = useState('');
  const [mobileError, setMobileError] = useState('');

  // Recursive function to list all file references and their categories under a given Storage reference
  const listAllRecursive = useCallback(async (storageRef) => {
    let allMetadata = [];
    try {
      const res = await listAll(storageRef);

      // Get metadata for files directly in this folder
      for (const itemRef of res.items) {
        const fullPath = itemRef.fullPath;
        // Extract category from path: tattoos/category/image.jpg -> category
        const pathParts = fullPath.split('/');
        const category = pathParts.length > 1 && pathParts[0] === 'tattoos' ? pathParts[1] : 'uncategorized';
        allMetadata.push({ ref: itemRef, fullPath, category });
      }

      // Recursively list files in subfolders (prefixes)
      for (const prefixRef of res.prefixes) {
        const subfolderMetadata = await listAllRecursive(prefixRef);
        allMetadata = allMetadata.concat(subfolderMetadata);
      }
    } catch (error) {
      console.warn(`Error listing items in ${storageRef.fullPath}: ${error.message}`);
    }
    return allMetadata;
  }, []);

  // Helper to get a random element from an array
  const getRandomElement = useCallback((arr) => {
    return arr[Math.floor(Math.random() * arr.length)];
  }, []);

  // Helper to get a weighted random category based on liked counts
  const getWeightedRandomCategory = useCallback(() => {
    const categories = Object.keys(likedCategoriesCount);
    if (categories.length === 0) return null;

    let totalWeight = 0;
    for (const category of categories) {
      totalWeight += likedCategoriesCount[category];
    }

    // If no likes, or only 0 counts, pick a random category
    if (totalWeight === 0) {
      return getRandomElement(categories);
    }

    let randomNumber = Math.random() * totalWeight;
    for (const category of categories) {
      randomNumber -= likedCategoriesCount[category];
      if (randomNumber <= 0) {
        return category;
      }
    }
    return getRandomElement(categories); // Fallback
  }, [likedCategoriesCount, getRandomElement]);

  // Function to determine the next image index based on recommendation logic
  const getNextImageIndex = useCallback(() => {
    const availableIndices = Array.from(unseenImageIndices);

    // If all images have been seen, reset the unseen list and start over
    if (availableIndices.length === 0 && tattooImagesMetadata.length > 0) {
      const newUnseen = new Set(Array.from({ length: tattooImagesMetadata.length }, (_, i) => i));
      setUnseenImageIndices(newUnseen);
      // Now availableIndices will be reset to all images
      return getRandomElement(Array.from(newUnseen)); // Return a random index from the reset list
    }

    // Strategy 1: Try to recommend from liked categories (70% chance)
    if (Math.random() < 0.7 && Object.keys(likedCategoriesCount).length > 0) {
      const recommendedCategory = getWeightedRandomCategory();
      if (recommendedCategory) {
        const potentialIndices = availableIndices.filter(
          idx => tattooImagesMetadata[idx].category === recommendedCategory
        );
        if (potentialIndices.length > 0) {
          return getRandomElement(potentialIndices);
        }
      }
    }

    // Strategy 2: Fallback to a completely random unseen image
    if (availableIndices.length > 0) {
      return getRandomElement(availableIndices);
    }

    // Fallback if no images or no unseen images (should be caught by checks above)
    return 0; // Default to first image if nothing else works
  }, [unseenImageIndices, tattooImagesMetadata, likedCategoriesCount, getWeightedRandomCategory, getRandomElement]);


  // 1. Firebase Initialization and Authentication
  useEffect(() => {
    console.log("Firebase useEffect: Initializing Firebase app...");
    if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
      const errorMsg = "Firebase config is missing or empty. Please provide it.";
      console.error(errorMsg);
      setFirebaseInitError(errorMsg);
      return;
    }

    try {
      const app = initializeApp(firebaseConfig);
      const authInstance = getAuth(app);
      const dbInstance = getFirestore(app);
      const storageInstance = getStorage(app);

      setAuth(authInstance);
      setDb(dbInstance);
      setStorage(storageInstance);

      const authenticate = async () => {
        try {
          console.log("Firebase useEffect: Attempting anonymous sign-in...");
          await signInAnonymously(authInstance);
          const currentUserUid = authInstance.currentUser?.uid;
          if (currentUserUid) {
            setUserId(currentUserUid);
            setIsAuthReady(true);
            console.log("Firebase useEffect: Auth ready. User ID:", currentUserUid);
          } else {
            const generatedId = crypto.randomUUID();
            setUserId(generatedId);
            setIsAuthReady(true);
            console.error("Firebase useEffect: Anonymous sign-in resolved but no UID found, using generated UUID. Data storage may fail.");
            setFirebaseInitError("Authentication error: User ID not available after sign-in. Data storage may fail.");
          }
        } catch (error) {
          const errorMsg = `Firebase authentication error: ${error.message}`;
          console.error(errorMsg, error);
          setUserId(crypto.randomUUID());
          setIsAuthReady(true);
          setFirebaseInitError(errorMsg + ". Please ensure Anonymous Authentication is enabled in your Firebase project.");
        }
      };

      authenticate();
    } catch (error) {
      const errorMsg = `Error initializing Firebase application: ${error.message}`;
      console.error(errorMsg, error);
      setFirebaseInitError(errorMsg);
    }
  }, [firebaseConfig]);

  // 2. Fetch Image References and Metadata from Firebase Storage (recursively from 'tattoos/' folder)
  useEffect(() => {
    if (!storage) {
      console.log("Storage not initialized yet, skipping image metadata fetch.");
      return;
    }

    const fetchAllTattooImagesMetadata = async () => {
      setMetadataLoading(true); // Indicate loading of metadata
      setImagesError(null); // Clear previous errors
      try {
        const rootTattoosRef = ref(storage, 'tattoos/'); // Reference to the main 'tattoos' folder
        const allMetadata = await listAllRecursive(rootTattoosRef); // Use the recursive function

        if (allMetadata.length === 0) {
          setImagesError("No tattoo images found in the 'tattoos/' folder or its subfolders. Please upload images there.");
        }

        // Shuffle the initial list of images
        const shuffledMetadata = allMetadata.sort(() => Math.random() - 0.5);
        setTattooImagesMetadata(shuffledMetadata);

        // Initialize unseenImageIndices with all indices
        setUnseenImageIndices(new Set(Array.from({ length: shuffledMetadata.length }, (_, i) => i)));

        console.log("Successfully fetched and shuffled all image metadata:", shuffledMetadata.map(m => m.fullPath));

      } catch (error) {
        const errorMsg = `Critical error fetching image metadata from Firebase Storage: ${error.message}. Please ensure Firebase Storage is enabled and rules allow read access to the 'tattoos' folder and its subfolders.`;
        console.error(errorMsg, error);
        setImagesError(errorMsg);
      } finally {
        setMetadataLoading(false); // Done loading metadata
      }
    };

    fetchAllTattooImagesMetadata();
  }, [storage, listAllRecursive]);

  // 3. Fetch current image URL when index or metadata change
  useEffect(() => {
    const loadImage = async () => {
      if (tattooImagesMetadata.length > 0 && currentImageIndex < tattooImagesMetadata.length) {
        setCurrentImageLoading(true); // Indicate loading of current image
        setImagesError(null); // Clear previous errors
        try {
          const url = await getDownloadURL(tattooImagesMetadata[currentImageIndex].ref);
          setCurrentImageUrl(url);
          console.log(`Loaded image URL for index ${currentImageIndex}: ${url}`);
        } catch (error) {
          const errorMsg = `Error loading image for index ${currentImageIndex}: ${error.message}`;
          console.error(errorMsg, error);
          setImagesError(errorMsg);
          setCurrentImageUrl(null); // Clear URL on error
        } finally {
          setCurrentImageLoading(false); // Done loading current image
        }
      } else if (tattooImagesMetadata.length === 0 && !metadataLoading && !imagesError) {
        // No images found after metadata loaded, and no general error
        setImagesError("No tattoo images found in the 'tattoos/' folder or its subfolders. Please upload images there.");
        setCurrentImageUrl(null);
      } else if (currentImageIndex >= tattooImagesMetadata.length && tattooImagesMetadata.length > 0) {
        // All images viewed, clear current image
        setCurrentImageUrl(null);
      }
    };

    loadImage();
  }, [currentImageIndex, tattooImagesMetadata, metadataLoading, imagesError]);

  // Function to move to the next image
  const goToNextImage = useCallback(() => {
    if (timerRunning && tattooImagesMetadata.length > 0) {
      const nextIndex = getNextImageIndex();
      setCurrentImageIndex(nextIndex);
      // Mark the current image as seen
      setUnseenImageIndices(prev => {
        const newSet = new Set(prev);
        newSet.delete(nextIndex); // Delete the index that was just displayed
        return newSet;
      });

      if (unseenImageIndices.size === 1 && tattooImagesMetadata.length > 0) { // If only one left before this action
        setAllImagesViewed(true);
        setShowContactModal(true);
        setTimerRunning(false);
        clearInterval(timerIntervalRef.current);
      }
      setCardTransform('translateX(0px) rotate(0deg)');
      setCardCardTransition('none');
    }
  }, [timerRunning, tattooImagesMetadata, getNextImageIndex, unseenImageIndices]);


  const handleLike = useCallback(() => {
    if (!timerRunning || tattooImagesMetadata.length === 0) return;

    // Increment count for the liked category
    const currentCategory = tattooImagesMetadata[currentImageIndex]?.category;
    if (currentCategory) {
      setLikedCategoriesCount(prev => ({
        ...prev,
        [currentCategory]: (prev[currentCategory] || 0) + 1
      }));
    }

    // Store the full path of the liked image
    setLikedImages(prev => [...prev, tattooImagesMetadata[currentImageIndex]?.fullPath || 'unknown_path']);
    goToNextImage();
  }, [goToNextImage, timerRunning, tattooImagesMetadata, currentImageIndex]);

  const handleDislike = useCallback(() => {
    if (!timerRunning || tattooImagesMetadata.length === 0) return;
    // Store the full path of the disliked image
    setDislikedImages(prev => [...prev, tattooImagesMetadata[currentImageIndex]?.fullPath || 'unknown_path']);
    goToNextImage();
  }, [goToNextImage, timerRunning, tattooImagesMetadata, currentImageIndex]);

  const handleReset = useCallback(() => {
    setCurrentImageIndex(0);
    setAllImagesViewed(false);
    setLikedImages([]);
    setDislikedImages([]);
    setTimeLeft(60);
    setTimerRunning(true);
    setShowContactModal(false);
    setSubmissionCompleted(false);
    setEmail('');
    setMobile('');
    setEmailError('');
    setMobileError('');
    setIsSavingData(false);
    setSubmissionError('');
    setCardTransform('translateX(0px) rotate(0deg)');
    setCardCardTransition('none');
    // Reset recommendation system states
    setLikedCategoriesCount({});
    setUnseenImageIndices(new Set(Array.from({ length: tattooImagesMetadata.length }, (_, i) => i)));
  }, [tattooImagesMetadata.length]); // Depend on metadata length to re-initialize unseen indices

  useEffect(() => {
    if (timerRunning && timeLeft > 0) {
      timerIntervalRef.current = setInterval(() => {
        setTimeLeft(prevTime => prevTime - 1);
      }, 1000);
    } else if (timeLeft === 0) {
      setTimerRunning(false);
      clearInterval(timerIntervalRef.current);
      setShowContactModal(true);
    }
    return () => {
      clearInterval(timerIntervalRef.current);
    };
  }, [timeLeft, timerRunning]);

  const handlePointerDown = useCallback((e) => {
    if (!timerRunning || tattooImagesMetadata.length === 0) return;
    if (e.button === 0 || e.pointerType === 'touch') {
      setIsDragging(true);
      setStartX(e.clientX);
      setCurrentX(e.clientX);
      setCardCardTransition('none');
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, [timerRunning, tattooImagesMetadata.length]);

  const handlePointerMove = useCallback((e) => {
    if (!isDragging || !timerRunning || tattooImagesMetadata.length === 0) return;
    const newCurrentX = e.clientX;
    const deltaX = newCurrentX - startX;
    const rotation = deltaX * 0.1;
    setCardTransform(`translateX(${deltaX}px) rotate(${rotation}deg)`);
    setCurrentX(newCurrentX);
  }, [isDragging, startX, timerRunning, tattooImagesMetadata.length]);

  const handlePointerUp = useCallback((e) => {
    if (!isDragging || !timerRunning || tattooImagesMetadata.length === 0) return;
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);

    const deltaX = currentX - startX;

    if (Math.abs(deltaX) > swipeThreshold) {
      const finalTranslateX = deltaX > 0 ? window.innerWidth * 1.5 : -window.innerWidth * 1.5;
      const rotation = deltaX * 0.1;
      setCardCardTransition('transform 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)');
      setCardTransform(`translateX(${finalTranslateX}px) rotate(${rotation}deg)`);
    } else {
      setCardCardTransition('transform 0.3s ease-out');
      setCardTransform('translateX(0px) rotate(0deg)');
    }
  }, [isDragging, currentX, startX, swipeThreshold, timerRunning, tattooImagesMetadata.length]);

  useEffect(() => {
    const cardElement = cardRef.current;
    const onTransitionEnd = () => {
      const currentTransform = cardElement.style.transform;
      if (currentTransform.includes('translateX(') && !currentTransform.includes('translateX(0px)')) {
        const deltaX = currentX - startX;
        if (deltaX > 0) {
          handleLike();
        } else {
          handleDislike();
        }
      }
      setCardCardTransition('none');
    };
    if (cardElement) {
      cardElement.addEventListener('transitionend', onTransitionEnd);
    }
    return () => {
      if (cardElement) {
        cardElement.removeEventListener('transitionend', onTransitionEnd);
      }
    };
  }, [cardTransform, isDragging, currentX, startX, handleLike, handleDislike]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log("Submit button clicked. Starting validation...");
    setSubmissionError('');

    let valid = true;
    setEmailError('');
    setMobileError('');

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setEmailError('Please enter a valid email address.');
      valid = false;
    }

    const mobileRegex = /^\d{10}$/;
    if (!mobileRegex.test(mobile)) {
      setMobileError('Please enter a 10-digit mobile number.');
      valid = false;
    }
    console.log("Validation passed:", valid);

    if (valid) {
      console.log("Firebase readiness check before saving:", {db: !!db, userId: !!userId, isAuthReady});
      if (!db || !userId || !isAuthReady) {
        const errorMsg = "Firebase connection not ready. Cannot save data. Please check console for details.";
        console.error(errorMsg + " Current states:", {db, userId, isAuthReady});
        setSubmissionError(errorMsg);
        return;
      }

      setIsSavingData(true);

      try {
        const userDocRef = doc(db, 'artifacts', currentAppId, 'users', userId, 'user_preferences', 'contact_info');
        console.log("Attempting to save data to Firestore path:", userDocRef.path);

        const docSnap = await getDoc(userDocRef);

        const dataToSave = {
          email: email,
          mobile: mobile,
          // Store full paths of liked/disliked images
          likedImages: likedImages,
          dislikedImages: dislikedImages,
          timestamp: new Date().toISOString(),
        };

        if (docSnap.exists()) {
          await setDoc(userDocRef, dataToSave, { merge: true });
          console.log("User data updated successfully!");
        } else {
          await setDoc(userDocRef, dataToSave);
          console.log("User data saved successfully!");
        }
        setSubmissionCompleted(true);
      } catch (error) {
        const errorMsg = `Error saving data to Firestore: ${error.message}. Please verify Firebase Security Rules for 'artifacts/${currentAppId}/users/{userId}/{document=**}' and ensure Anonymous Authentication is enabled.`;
        console.error(errorMsg, error);
        setSubmissionError(errorMsg);
      } finally {
        setIsSavingData(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-700 text-white flex items-center justify-center p-4 font-inter select-none">
      {/* Main container for the tattoo liker */}
      <div className="bg-gray-800 p-6 rounded-xl shadow-2xl w-full max-w-sm flex flex-col items-center space-y-6">
        <h1 className="text-3xl font-bold text-center mb-4 text-orange-400">Flaunt it</h1>

        {/* Display Firebase initialization error if any */}
        {firebaseInitError && (
          <div className="bg-red-700 text-white p-3 rounded-md mb-4 text-center">
            <p className="font-bold">Firebase Initialization Error:</p>
            <p className="text-sm">{firebaseInitError}</p>
          </div>
        )}

        {/* Timer Display */}
        <div className="text-xl font-semibold text-gray-300">
          Time Left: <span className={timeLeft <= 10 && timerRunning ? "text-red-500" : "text-green-400"}>
            {timeLeft}s
          </span>
        </div>

        {/* The main content area where images are displayed and interacted with */}
        {!showContactModal && (
          metadataLoading ? ( // Show loading for image metadata
            <div className="text-center text-lg space-y-4 text-gray-400">
              <p>Preparing tattoo image list...</p>
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-400 mx-auto"></div>
            </div>
          ) : imagesError ? ( // Show error if fetching metadata failed
            <div className="text-center text-lg space-y-4 text-red-400">
              <p className="font-bold">Error loading images:</p>
              <p className="text-sm">{imagesError}</p>
              <p className="text-sm text-gray-400">Please ensure Firebase Storage is enabled and rules allow read access to the 'tattoos' folder and its subfolders.</p>
            </div>
          ) : tattooImagesMetadata.length === 0 ? ( // No images found after metadata loaded
            <div className="text-center text-lg space-y-4 text-gray-400">
              <p>No tattoo images found in the 'tattoos/' folder or its subfolders.</p>
              <p className="text-sm">Please upload images directly to the 'tattoos/' folder or into subfolders within it in Firebase Storage.</p>
            </div>
          ) : allImagesViewed ? (
            <div className="text-center text-lg space-y-4">
              <p className="text-xl font-semibold">That's all for now!</p>
              <p className="text-gray-400">Please submit your details in the popup to continue your journey!</p>
            </div>
          ) : (
            <>
              {/* Tattoo Image Card - Swipeable */}
              {/* pb-[150%] for 2:3 aspect ratio (width:height) */}
              <div
                key={currentImageIndex} // Key ensures component remounts for fresh animation state when image changes
                ref={cardRef}
                className={`relative w-full pb-[150%] bg-gray-700 rounded-lg overflow-hidden shadow-lg border-2 border-gray-600 ${timerRunning ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed opacity-50'}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={isDragging ? handlePointerUp : null}
                style={{ transform: cardTransform, transition: cardTransition, willChange: 'transform' }}
              >
                {currentImageLoading ? ( // Show loading spinner for current image
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-700 bg-opacity-75">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-400"></div>
                  </div>
                ) : (
                  <img
                    src={currentImageUrl || 'https://placehold.co/400x500/333/FFF?text=Image%0ALoad%0AError'}
                    alt={`Tattoo ${currentImageIndex + 1}`}
                    // Ensure image fills the new aspect ratio container
                    className="absolute inset-0 w-full h-full object-cover rounded-lg"
                    onError={(e) => {
                      e.target.onerror = null;
                      e.target.src = 'https://placehold.co/400x500/333/FFF?text=Image%0ALoad%0AError';
                    }}
                  />
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-transparent to-transparent h-1/3 flex items-end p-4">
                  <p className="text-xl font-semibold text-white">Tattoo #{currentImageIndex + 1}</p>
                </div>
              </div>

              {/* Like/Dislike Buttons */}
              <div className="flex w-full justify-around space-x-4 mt-6">
                <button
                  onClick={handleDislike}
                  className="flex-1 bg-black hover:bg-gray-900 text-white font-bold py-3 px-6 rounded-full transition duration-300 ease-in-out transform hover:scale-105 shadow-lg flex items-center justify-center space-x-2"
                  disabled={isDragging || !timerRunning || currentImageLoading}
                >
                  <span className="text-2xl">💔</span>
                  <span>Dislike</span>
                </button>
                <button
                  onClick={handleLike}
                  className="flex-1 bg-black hover:bg-gray-900 text-white font-bold py-3 px-6 rounded-full transition duration-300 ease-in-out transform hover:scale-105 shadow-lg flex items-center justify-center space-x-2"
                  disabled={isDragging || !timerRunning || currentImageLoading}
                >
                  <span className="text-2xl">❤️</span>
                  <span>Like</span>
                </button>
              </div>

              {/* Optional: Display current counts */}
              <div className="flex justify-between w-full text-sm mt-4 text-gray-400">
                <span>Liked: <span className="font-semibold text-green-300">{likedImages.length}</span></span>
                <span>Disliked: <span className="font-semibold text-red-300">{dislikedImages.length}</span></span>
              </div>
            </>
          )
        )}
      </div>

      {/* Contact Modal */}
      {showContactModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 p-8 rounded-xl shadow-2xl max-w-md w-full text-center space-y-6">
            {!submissionCompleted ? (
              <>
                <h2 className="text-2xl font-bold text-orange-400">Don't Miss Out!</h2>
                <p className="text-gray-300">
                  Want to receive news and be the first to get our professional tattoos?
                </p>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <input
                    type="email"
                    placeholder="Your Email"
                    className={`w-full p-3 rounded-lg bg-gray-700 border text-white placeholder-gray-400 focus:outline-none focus:ring-2 ${emailError ? 'border-red-500 focus:ring-red-500' : 'border-gray-600 focus:ring-orange-500'}`}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                  {emailError && <p className="text-red-400 text-sm -mt-2">{emailError}</p>}
                  <input
                    type="tel"
                    placeholder="Your Mobile Number (10 digits)"
                    className={`w-full p-3 rounded-lg bg-gray-700 border text-white placeholder-gray-400 focus:outline-none focus:ring-2 ${mobileError ? 'border-red-500 focus:ring-red-500' : 'border-gray-600 focus:ring-orange-500'}`}
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    required
                  />
                  {mobileError && <p className="text-red-400 text-sm -mt-2">{mobileError}</p>}
                  {submissionError && (
                    <p className="text-red-400 text-sm -mt-2">{submissionError}</p>
                  )}
                  <button
                    type="submit"
                    className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-6 rounded-full transition duration-300 ease-in-out transform hover:scale-105 shadow-lg"
                    disabled={isSavingData}
                  >
                    {isSavingData ? 'Saving...' : 'Submit'}
                  </button>
                </form>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-bold text-orange-400">Thank you!</h2>
                <p className="text-gray-300">
                  Thank you for connecting with **Flaunt it**! Look forward to exciting updates and exclusive opportunities in the future.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
