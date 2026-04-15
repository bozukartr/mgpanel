// Firebase Configuration - Replace with your own config from Firebase Console
const firebaseConfig = {
    apiKey: "AIzaSyA9gr0enNzAxFNVcWAn9oiLLMJn5DfgCac",
    authDomain: "panel-d25c9.firebaseapp.com",
    projectId: "panel-d25c9",
    storageBucket: "panel-d25c9.firebasestorage.app",
    messagingSenderId: "201774041360",
    appId: "1:201774041360:web:b7725c119584a03c643d95",
    measurementId: "G-6T3QV04GDS"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
