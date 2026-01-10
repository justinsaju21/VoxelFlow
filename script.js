/* ============================================
   VOXEL EDITOR - Main Application
   ============================================
   
   Combines Three.js voxel placement logic with
   MediaPipe HandLandmarker for gesture control.
   
   Coordinate Transformation Math:
   --------------------------------
   1. MediaPipe returns landmarks in normalized [0,1] space
   2. We convert to screen-centered coordinates
   3. Then to NDC (Normalized Device Coordinates) [-1,1]
   4. Finally unproject to 3D world space using camera
   
   Smoothing:
   ----------
   EMA (Exponential Moving Average) reduces hand jitter:
   smoothed = α × current + (1 - α) × previous
   where α = 0.4 (lower = more smoothing)
*/

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // Grid settings
    GRID_SIZE: 10,           // 10x10 grid
    VOXEL_SIZE: 1,           // Size of each voxel

    // Hand tracking - TUNED FOR STABILITY
    SMOOTHING_ALPHA: 0.15,   // EMA for landmarks - lower = more stable (was 0.25)
    GHOST_SMOOTHING: 0.12,   // Ghost voxel lerp speed - lower = smoother (was 0.3)
    PINCH_THRESHOLD: 0.09,   // Easiesr pinch detection (was 0.06)

    // DWELL-TO-PLACE: Hold in same spot to auto-place
    DWELL_TIME: 1500,        // Milliseconds to hold before auto-place (was 800)
    DWELL_TOLERANCE: 0.5,    // Movement tolerance during dwell (was 0.1)

    // Ghost voxel
    GHOST_OPACITY: 0.4,
    GHOST_COLOR: 0x00d4ff,

    // Placed voxels
    VOXEL_COLORS: [
        0x00ff88, 0xff6b6b, 0x00d4ff, 0xffd93d,
        0xff7eb3, 0x6bcb77, 0xc9b1ff, 0xffa45b
    ],

    // Placement plane (Z depth where voxels are placed)
    PLACEMENT_DEPTH: 0,

    // Interaction settings
    GRAVITY_ENABLED: false,  // Toggled by user
    GRAVITY_RATE: 5          // Apply gravity every N frames
};

// ============================================
// STATE
// ============================================

let scene, camera, renderer, controls;
let handLandmarker = null;
let webcamElement, lastVideoTime = -1;

// Hand state
let handDetected = false;
let detectedHandCount = 0;
let smoothers = { 'Left': null, 'Right': null }; // Stores EMA state for hands by label
let debugPinchState = { 'Left': false, 'Right': false }; // For UI debugging
let isPinching = false;
let wasPinching = false;       // Previous frame's pinch state
let blockPlacedThisPinch = false;  // Prevent spam on hold

// Toolbar State
let activeColor = CONFIG.VOXEL_COLORS[0]; // Default color

// Ghost voxel (placement preview)
let ghostVoxel = null;
let ghostPosition = new THREE.Vector3();

// Voxel storage
const voxels = [];
const voxelMap = new Map(); // Key: "x,y,z" -> voxel mesh for O(1) lookup

// UI elements
let handStatusEl, pinchStatusEl, fpsDisplayEl, voxelCountEl;

// FPS tracking
let frameCount = 0;
let lastFpsTime = performance.now();

// PERFORMANCE: Reusable objects to avoid GC pressure
const reusableRaycaster = new THREE.Raycaster();
const reusableNDC = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);  // y=0 plane
let floor = null;  // Reference to floor mesh for raycasting

// Ghost position smoothing
let smoothedGhostPosition = new THREE.Vector3(0, 0.5, 0);
let lastPlacementPosition = new THREE.Vector3();  // Store stable position for placement

// DWELL-TO-PLACE state
let dwellStartTime = 0;
let dwellPosition = new THREE.Vector3();
let isDwelling = false;
let dwellProgress = 0;  // 0 to 1
let dwellRing = null;   // Visual indicator

// SYSTEMS
let audioManager = null;
let particleSystem = null;

// ============================================
// AUDIO & PARTICLES
// ============================================

class AudioManager {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.3; // Low volume
        this.masterGain.connect(this.ctx.destination);
    }

    resume() {
        if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    playPlace() {
        this.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(400, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(800, this.ctx.currentTime + 0.1);

        gain.gain.setValueAtTime(0, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(this.masterGain);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.3);
    }

    playRemove() {
        this.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth'; // Rougher sound
        osc.frequency.setValueAtTime(200, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, this.ctx.currentTime + 0.2);

        gain.gain.setValueAtTime(0, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.8, this.ctx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);

        osc.connect(gain);
        gain.connect(this.masterGain);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.2);
    }
}

class ParticleSystem {
    constructor(scene) {
        this.particles = [];
        this.scene = scene;

        // Reuse geometry/material
        this.geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        this.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    }

    spawn(position, color, count = 8) {
        for (let i = 0; i < count; i++) {
            const mesh = new THREE.Mesh(this.geometry, this.material.clone());
            mesh.material.color.setHex(color);
            mesh.position.copy(position);

            // Random velocity
            const velocity = new THREE.Vector3(
                (Math.random() - 0.5) * 0.2,
                (Math.random() - 0.5) * 0.2 + 0.2, // Upward bias
                (Math.random() - 0.5) * 0.2
            );

            this.scene.add(mesh);
            this.particles.push({ mesh, velocity, age: 0 });
        }
    }

    update() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.age += 1;

            // Physics
            p.mesh.position.add(p.velocity);
            p.velocity.y -= 0.01; // Gravity
            p.mesh.rotation.x += 0.1;
            p.mesh.rotation.y += 0.1;
            p.mesh.scale.multiplyScalar(0.9); // Shrink

            if (p.age > 40) {
                this.scene.remove(p.mesh);
                p.mesh.material.dispose();
                this.particles.splice(i, 1);
            }
        }
    }
}

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    console.log('🎮 Voxel Editor initializing...');

    // Get UI elements
    handStatusEl = document.getElementById('hand-status');
    pinchStatusEl = document.getElementById('pinch-status');
    fpsDisplayEl = document.getElementById('fps-display');
    voxelCountEl = document.getElementById('count');
    webcamElement = document.getElementById('webcam');



    // Systems
    audioManager = new AudioManager();

    // Setup Three.js scene
    setupScene();

    // Init particles
    particleSystem = new ParticleSystem(scene);

    // Load saved map
    loadMap();

    // Setup MediaPipe hand tracking
    await setupHandTracking();

    // Hide loading overlay
    document.getElementById('loading-overlay').classList.add('hidden');

    // Setup close banner button
    const closeBannerBtn = document.getElementById('close-banner');
    const instructionsBanner = document.getElementById('instructions-banner');
    if (closeBannerBtn && instructionsBanner) {
        closeBannerBtn.addEventListener('click', () => {
            instructionsBanner.classList.add('hidden');
            setTimeout(() => {
                instructionsBanner.style.display = 'none';
            }, 400); // Wait for animation to complete
        });
    }

    // Start animation loop
    animate();

    console.log('✅ Voxel Editor ready!');
}

// ============================================
// THREE.JS SCENE SETUP
// ============================================

function setupScene() {
    const container = document.getElementById('container');

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a15);

    // Add subtle fog for depth
    scene.fog = new THREE.Fog(0x0a0a15, 15, 40);

    // Camera
    camera = new THREE.PerspectiveCamera(
        60,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(8, 8, 12);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // OrbitControls for camera manipulation
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 5;
    controls.maxDistance = 50;
    controls.target.set(0, 0, 0);

    // Lighting
    setupLighting();

    // Grid
    createGrid();

    // Ghost voxel (placement preview)
    createGhostVoxel();

    // Handle window resize
    window.addEventListener('resize', onWindowResize);
}

function setupLighting() {
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    // Main directional light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 15, 10);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 50;
    directionalLight.shadow.camera.left = -15;
    directionalLight.shadow.camera.right = 15;
    directionalLight.shadow.camera.top = 15;
    directionalLight.shadow.camera.bottom = -15;
    scene.add(directionalLight);

    // Fill light
    const fillLight = new THREE.DirectionalLight(0x00d4ff, 0.3);
    fillLight.position.set(-5, 5, -5);
    scene.add(fillLight);

    // Hemisphere light for natural feel
    const hemiLight = new THREE.HemisphereLight(0x00d4ff, 0x1a1a2e, 0.3);
    scene.add(hemiLight);
}

function createGrid() {
    const gridSize = CONFIG.GRID_SIZE;
    const halfSize = gridSize / 2;

    // Grid helper
    const gridHelper = new THREE.GridHelper(gridSize, gridSize, 0x444466, 0x222244);
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    // Floor plane (for raycasting)
    const floorGeometry = new THREE.PlaneGeometry(gridSize, gridSize);
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x1a1a2e,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide
    });
    floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    floor.name = 'floor';
    scene.add(floor);
}

function createGhostVoxel() {
    /* 
     * Ghost Voxel: Semi-transparent preview cube
     * Shows where the next voxel will be placed
     * Snaps to discrete grid positions
     */
    const geometry = new THREE.BoxGeometry(
        CONFIG.VOXEL_SIZE * 0.98,  // Slightly smaller for visual gap
        CONFIG.VOXEL_SIZE * 0.98,
        CONFIG.VOXEL_SIZE * 0.98
    );

    const material = new THREE.MeshStandardMaterial({
        color: CONFIG.GHOST_COLOR,
        transparent: true,
        opacity: CONFIG.GHOST_OPACITY,
        emissive: CONFIG.GHOST_COLOR,
        emissiveIntensity: 0.2
    });

    ghostVoxel = new THREE.Mesh(geometry, material);
    ghostVoxel.visible = false;  // Hidden until hand detected
    scene.add(ghostVoxel);

    setupToolbar(); // Initialize UI controls

    // Create dwell progress ring
    createDwellIndicator();
}

function setupToolbar() {
    // 1. Color Palette
    const paletteContainer = document.getElementById('color-palette');
    CONFIG.VOXEL_COLORS.forEach((color, index) => {
        const hexColor = '#' + color.toString(16).padStart(6, '0');
        const btn = document.createElement('div');
        btn.className = 'color-swatch' + (index === 0 ? ' active' : '');
        btn.style.backgroundColor = hexColor;
        btn.style.color = hexColor; // Store for effect reference

        btn.addEventListener('click', () => {
            activeColor = color;
            // Visual update
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            btn.classList.add('active');
            // Change ghost color to match
            // CONFIG.GHOST_COLOR = color; // Optional: change ghost color?
            // Let's keep ghost blue for visibility or match active?
            // To match active:
            ghostVoxel.material.emissive.setHex(color);
        });

        paletteContainer.appendChild(btn);
    });

    // 2. Gravity Toggle
    const toggle = document.getElementById('gravity-toggle');
    toggle.addEventListener('change', (e) => {
        CONFIG.GRAVITY_ENABLED = e.target.checked;
        console.log('Gravity:', CONFIG.GRAVITY_ENABLED ? 'ON' : 'OFF');
    });

    // 3. Reset Button (Double click to confirm logic)
    const resetBtn = document.getElementById('btn-reset');
    let resetTimeout;

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (resetBtn.classList.contains('confirming')) {
                // Confirmed!
                clearScene(true); // Pass true to skip dialog (if kept)
                // Reset button state
                resetBtn.classList.remove('confirming');
                resetBtn.innerHTML = '🗑️';
                clearTimeout(resetTimeout);
            } else {
                // First click - Ask for confirmation
                resetBtn.classList.add('confirming');
                resetBtn.innerHTML = '❓'; // Question mark

                // Revert after 3s
                resetTimeout = setTimeout(() => {
                    resetBtn.classList.remove('confirming');
                    resetBtn.innerHTML = '🗑️';
                }, 3000);
            }
        });
    } else {
        console.error('Reset button not found!');
    }
}

function createDwellIndicator() {
    // Create a ring that fills up as you dwell
    const ringGeometry = new THREE.RingGeometry(0.6, 0.75, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide
    });
    dwellRing = new THREE.Mesh(ringGeometry, ringMaterial);
    dwellRing.visible = false;
    scene.add(dwellRing);
}

// ============================================
// MEDIAPIPE HAND TRACKING SETUP
// ============================================

async function setupHandTracking() {
    console.log('🖐️ Setting up hand tracking...');
    document.getElementById('loading-text').textContent = 'Loading HandLandmarker model...';

    try {
        // Initialize MediaPipe Vision
        const vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
        );

        // Create HandLandmarker
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
                delegate: 'GPU'  // Use GPU for better performance
            },
            numHands: 2,         // Track two hands for precision control
            runningMode: 'VIDEO'
        });

        console.log('✅ HandLandmarker created');

        // Setup webcam
        document.getElementById('loading-text').textContent = 'Requesting camera access...';
        // PERFORMANCE: Lower resolution for faster hand detection
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'user',
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: false
        });

        webcamElement.srcObject = stream;

        // Wait for video metadata
        await new Promise(resolve => {
            webcamElement.onloadedmetadata = resolve;
        });
        await webcamElement.play();

        console.log('✅ Webcam ready');

    } catch (error) {
        console.error('❌ Hand tracking setup failed:', error);
        document.getElementById('loading-text').textContent =
            'Error: ' + error.message + '. Please allow camera access.';
        throw error;
    }
}

// ============================================
// COORDINATE TRANSFORMATION
// ============================================

/**
 * Transform 2D MediaPipe landmark to 3D world position
 * 
 * MATH EXPLANATION:
 * -----------------
 * 1. MediaPipe landmarks are in [0,1] normalized space where:
 *    - (0,0) = top-left of video
 *    - (1,1) = bottom-right of video
 * 
 * 2. We mirror X because webcam is mirrored for intuitive control:
 *    mirroredX = 1 - landmark.x
 * 
 * 3. Convert to NDC (Normalized Device Coordinates) [-1, 1]:
 *    ndcX = mirroredX * 2 - 1
 *    ndcY = -(landmark.y * 2 - 1)  // Y is inverted in Three.js
 * 
 * 4. Use Raycaster to project from camera through NDC point onto
 *    a horizontal plane at y=0.5 (voxel placement height)
 * 
 * @param {Object} landmark - MediaPipe landmark with x, y, z properties
 * @returns {THREE.Vector3} - World position snapped to grid
 */
function landmarkToWorld(landmark) {
    // Mirror X for intuitive control (webcam is mirrored in CSS)
    const mirroredX = 1 - landmark.x;

    // Convert normalized [0,1] to NDC [-1,1]
    const ndcX = mirroredX * 2 - 1;
    const ndcY = -(landmark.y * 2 - 1);  // Flip Y axis
    // PERFORMANCE: Reuse raycaster instead of creating new one each frame
    reusableNDC.set(ndcX, ndcY);
    reusableRaycaster.setFromCamera(reusableNDC, camera);

    // STACKING PRIORITY: Check direct voxel hits first
    if (voxels.length > 0) {
        const voxelIntersects = reusableRaycaster.intersectObjects(voxels);
        if (voxelIntersects.length > 0) {
            const hit = voxelIntersects[0];
            let normal = hit.face.normal.clone();
            normal.transformDirection(hit.object.matrixWorld);

            // TOP EDGE MAGNETISM: If hitting side face near the top, snap to UP
            // This makes building UP much easier
            const localY = hit.object.worldToLocal(hit.point.clone()).y; // approx -0.5 to 0.5
            // If we are in top 20% (y > 0.3) and not already hitting top/bottom
            if (Math.abs(normal.y) < 0.9 && localY > 0.3) {
                normal.set(0, 1, 0); // Force UP direction
            }

            const newPos = hit.object.position.clone();
            newPos.add(normal.multiplyScalar(CONFIG.VOXEL_SIZE));
            return newPos;
        }
    }

    // FALLBACK: Intersect with floor
    const intersection = new THREE.Vector3();
    const floorHit = reusableRaycaster.ray.intersectPlane(floorPlane, intersection);

    if (floorHit) {
        // SMART STACKING: If we hit the floor, check if we are "inside" a column
        const size = CONFIG.VOXEL_SIZE;
        const gx = Math.floor(intersection.x / size) * size + size / 2;
        const gz = Math.floor(intersection.z / size) * size + size / 2;

        // Check if this column has blocks
        let highestBlockY = -1;

        // Simple search 0..10
        for (let i = 0; i < 15; i++) {
            const checkY = (i * size) + size / 2;
            const key = `${gx.toFixed(2)},${checkY.toFixed(2)},${gz.toFixed(2)}`;
            if (voxelMap.has(key)) {
                highestBlockY = checkY;
            }
        }

        if (highestBlockY !== -1) {
            // Found a stack! Snap to top of it
            intersection.x = gx;
            intersection.z = gz;
            intersection.y = highestBlockY + size;
            return intersection;
        }

        // Empty column, place at ground
        intersection.y = size / 2;
        return intersection;
    }

    // Ultimate fallback
    const fallbackPoint = new THREE.Vector3(ndcX, ndcY, 0.5);
    fallbackPoint.unproject(camera);
    fallbackPoint.y = CONFIG.VOXEL_SIZE / 2;
    return fallbackPoint;
}

/**
 * Apply Exponential Moving Average (EMA) smoothing
 * 
 * MATH: smoothed = α × current + (1 - α) × previous
 * 
 * - α = 0.4: Moderate responsiveness with good smoothing
 * - Higher α = more responsive but more jittery
 * - Lower α = smoother but more laggy
 * 
 * @param {Array} currentLandmarks - Current frame's raw landmarks
 * @returns {Array} - Smoothed landmarks
 */
function applySmoothing(currentLandmarks, label) {
    const alpha = CONFIG.SMOOTHING_ALPHA;

    if (!smoothers[label]) {
        // First frame: no previous data, use current as-is
        smoothers[label] = currentLandmarks.map(lm => ({ ...lm }));
        return smoothers[label];
    }

    // Apply EMA to each landmark
    smoothers[label] = currentLandmarks.map((lm, i) => {
        const prev = smoothers[label][i];
        return {
            x: alpha * lm.x + (1 - alpha) * prev.x,
            y: alpha * lm.y + (1 - alpha) * prev.y,
            z: alpha * lm.z + (1 - alpha) * prev.z
        };
    });

    return smoothers[label];
}

/**
 * Snap position to discrete grid
 * 
 * MATH: snapped = floor(pos / size) * size + size/2
 * 
 * This centers the voxel in the grid cell
 */
function snapToGrid(position) {
    const size = CONFIG.VOXEL_SIZE;
    const halfGrid = CONFIG.GRID_SIZE / 2;
    const maxHeight = 10;  // Maximum building height

    // Snap to grid - now includes Y axis for stacking!
    let x = Math.floor(position.x / size) * size + size / 2;
    let y = Math.floor(position.y / size) * size + size / 2;  // Stack vertically
    let z = Math.floor(position.z / size) * size + size / 2;

    // Clamp to grid bounds
    x = Math.max(-halfGrid + size / 2, Math.min(halfGrid - size / 2, x));
    y = Math.max(size / 2, Math.min(maxHeight * size - size / 2, y));  // Min y=0.5, max based on height
    z = Math.max(-halfGrid + size / 2, Math.min(halfGrid - size / 2, z));

    return new THREE.Vector3(x, y, z);
}

// ============================================
// GESTURE DETECTION
// ============================================

/**
 * Detect pinch gesture (thumb tip to index finger tip)
 * 
 * MediaPipe landmark indices:
 * - 4 = THUMB_TIP
 * - 8 = INDEX_FINGER_TIP
 * 
 * @param {Array} landmarks - Smoothed hand landmarks
 * @returns {boolean} - True if pinching
 */
function detectPinch(landmarks) {
    if (!landmarks || landmarks.length < 21) return false;

    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];

    // Calculate 2D distance (we ignore Z for pinch detection)
    const dx = thumbTip.x - indexTip.x;
    const dy = thumbTip.y - indexTip.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return distance < CONFIG.PINCH_THRESHOLD;
}

/**
 * Get pinch midpoint (center between thumb and index tips)
 * Used as the "cursor" position for voxel placement
 */
function getPinchMidpoint(landmarks) {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];

    return {
        x: (thumbTip.x + indexTip.x) / 2,
        y: (thumbTip.y + indexTip.y) / 2,
        z: (thumbTip.z + indexTip.z) / 2
    };
}

// ============================================
// VOXEL MANAGEMENT
// ============================================

/**
 * Create a position key for the voxel map
 */
function getVoxelKey(position) {
    return `${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`;
}

/**
 * Check if a voxel exists at position
 */
function getVoxelAt(position) {
    const key = getVoxelKey(position);
    return voxelMap.get(key);
}

/**
 * Place a new voxel at position
 */
/**
 * Place a new voxel at position - UPDATED
 */
function placeVoxel(position) {
    const key = getVoxelKey(position);

    // Don't place if one already exists here
    if (voxelMap.has(key)) return;

    // Use selected color
    const color = activeColor;

    // Create visual mesh
    createVoxelMesh(position, color);

    // EFFECTS
    if (audioManager) audioManager.playPlace();
    if (particleSystem) particleSystem.spawn(position, color, 4); // Fewer particles for placement

    // SAVE
    saveMap();

    // Update UI
    voxelCountEl.textContent = voxels.length;

    console.log(`📦 Placed voxel at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);
}

/**
 * Update the dwell progress indicator ring
 */
function updateDwellIndicator(position, progress) {
    if (!dwellRing) return;

    // Position ring above ghost voxel, facing camera
    dwellRing.position.copy(position);
    dwellRing.position.y += 0.8;
    dwellRing.lookAt(camera.position);
    dwellRing.visible = progress > 0.05;

    // Scale ring based on progress (grows larger as it fills)
    const scale = 0.5 + progress * 0.5;
    dwellRing.scale.set(scale, scale, 1);

    // Change color as progress increases (cyan -> green)
    const r = 0;
    const g = 0.7 + progress * 0.3;
    const b = 1 - progress * 0.5;
    dwellRing.material.color.setRGB(r, g, b);

    // Pulsing opacity
    dwellRing.material.opacity = 0.6 + Math.sin(performance.now() / 100) * 0.2;
}

/**
 * Remove a voxel at position - UPDATED
 */
function removeVoxel(position) {
    const key = getVoxelKey(position);
    const voxel = voxelMap.get(key);

    if (!voxel) return;

    // Spawn particles before removing (use voxel color)
    if (particleSystem) {
        particleSystem.spawn(voxel.position, voxel.material.color.getHex());
    }

    // Play sound
    if (audioManager) audioManager.playRemove();

    scene.remove(voxel);
    voxel.geometry.dispose();
    voxel.material.dispose();

    const index = voxels.indexOf(voxel);
    if (index > -1) voxels.splice(index, 1);

    voxelMap.delete(key);

    // Update UI
    voxelCountEl.textContent = voxels.length;

    console.log(`🗑️ Removed voxel at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);

    // Save
    saveMap();
}

// ============================================
// SAVING & LOADING
// ============================================

function saveMap() {
    const data = voxels.map(v => ({
        x: v.position.x,
        y: v.position.y,
        z: v.position.z,
        color: v.material.color.getHex()
    }));
    localStorage.setItem('voxel-map', JSON.stringify(data));
}

function loadMap() {
    const json = localStorage.getItem('voxel-map');
    if (!json) return;

    try {
        const data = JSON.parse(json);
        // Clear existing first (soft clear, don't delete save)
        voxels.forEach(v => {
            scene.remove(v);
            v.geometry.dispose();
            v.material.dispose();
        });
        voxels.length = 0;
        voxelMap.clear();

        // Rebuild
        data.forEach(item => {
            const pos = new THREE.Vector3(item.x, item.y, item.z);
            // Use internal create logic but skip save/sound
            createVoxelMesh(pos, item.color);
        });

        voxelCountEl.textContent = voxels.length;
        console.log(`📂 Loaded ${data.length} voxels`);
    } catch (e) {
        console.error('Failed to load map', e);
    }
}

function clearScene(skipConfirm = false) {
    // Deprecated native confirm - relying on UI double-tap 
    // if (!skipConfirm && !confirm('Clear all blocks?')) return;

    voxels.forEach(v => {
        scene.remove(v);
        v.geometry.dispose();
        v.material.dispose();
    });
    voxels.length = 0;
    voxelMap.clear();
    voxelCountEl.textContent = 0;
    saveMap(); // Save empty state

    if (audioManager) audioManager.playRemove();
}

// Helper to create mesh without side effects
function createVoxelMesh(position, color) {
    const geometry = new THREE.BoxGeometry(
        CONFIG.VOXEL_SIZE * 0.98,
        CONFIG.VOXEL_SIZE * 0.98,
        CONFIG.VOXEL_SIZE * 0.98
    );

    const material = new THREE.MeshStandardMaterial({
        color: color,
        roughness: 0.4,
        metalness: 0.1
    });

    const voxel = new THREE.Mesh(geometry, material);
    voxel.position.copy(position);
    voxel.castShadow = true;
    voxel.receiveShadow = true;

    scene.add(voxel);
    voxels.push(voxel);
    voxelMap.set(getVoxelKey(position), voxel);
}

/**
 * Update Gravity - Makes unsupported blocks fall
 */
function applyGravity() {
    if (!CONFIG.GRAVITY_ENABLED) return;

    // Sort voxels by Y (ascending) to process bottom-up
    // This ensures we drop the lowest unsupported block first
    // (Actually, if we drop bottom blocks, top ones might float for 1 frame, which is fine)
    // Wait, if we process bottom-up:
    // Y=2 unsupported. Y=3 supported by Y=2.
    // If we move Y=2 down to Y=1... Y=3 becomes unsupported next frame.
    // This creates a cascade over frames. Good.

    const size = CONFIG.VOXEL_SIZE;

    // Create a copy to iterate because we modify the map
    const currentVoxels = [...voxels];

    currentVoxels.forEach(voxel => {
        const pos = voxel.position;

        // If on ground, ignore
        if (pos.y <= size / 2 + 0.1) return;

        // Check below
        const belowPos = pos.clone();
        belowPos.y -= size;
        const belowKey = getVoxelKey(belowPos);

        if (!voxelMap.has(belowKey)) {
            // FALL!
            const oldKey = getVoxelKey(pos);
            voxelMap.delete(oldKey); // Remove old pos

            voxel.position.y -= size; // Drop

            const newKey = getVoxelKey(voxel.position);
            voxelMap.set(newKey, voxel); // Update new pos

            // Simple fall effect
            // if (particleSystem) particleSystem.spawn(pos, voxel.material.color.getHex(), 1);
        }
    });

    if (voxels.length > 0) saveMap(); // Save state if things moved
}

// ============================================
// MAIN UPDATE LOOP
// ============================================

function updateHandTracking() {
    if (!handLandmarker || !webcamElement.srcObject || webcamElement.readyState < 2) {
        return;
    }

    const videoTime = webcamElement.currentTime;
    if (videoTime === lastVideoTime) return;
    lastVideoTime = videoTime;

    // Detect hands
    const results = handLandmarker.detectForVideo(webcamElement, performance.now());

    // Update hand state
    detectedHandCount = results.landmarks ? results.landmarks.length : 0;
    handDetected = detectedHandCount > 0;

    let cursorHand = null;
    let triggerHand = null;

    if (handDetected) {
        // 1. Identify Roles by Label (Right vs Left)
        const hands = {};

        for (let i = 0; i < results.landmarks.length; i++) {
            const label = results.handedness[i][0].categoryName; // "Left" or "Right"
            const marks = results.landmarks[i];
            hands[label] = applySmoothing(marks, label);
        }

        if (detectedHandCount >= 2) {
            // TWO HAND MODE
            // Prefer Right for Cursor, Left for Trigger.
            cursorHand = hands['Right'] || hands['Left'];
            triggerHand = hands['Left'];
        } else {
            // ONE HAND MODE
            cursorHand = hands['Right'] || hands['Left'];
        }

        // 2. Cursor Logic
        if (cursorHand) {
            const cursorLandmark = cursorHand[8];  // INDEX_FINGER_TIP
            const worldPos = landmarkToWorld(cursorLandmark);
            const targetPosition = snapToGrid(worldPos);

            smoothedGhostPosition.lerp(targetPosition, CONFIG.GHOST_SMOOTHING);
            ghostPosition = snapToGrid(smoothedGhostPosition);
            lastPlacementPosition.copy(ghostPosition);

            ghostVoxel.position.copy(ghostPosition);
            ghostVoxel.visible = true;

            // Check intersection
            const existingVoxel = getVoxelAt(ghostPosition);
            const isOverExisting = !!existingVoxel;

            if (isOverExisting) {
                ghostVoxel.material.color.setHex(0xff6b6b);
                ghostVoxel.material.emissive.setHex(0xff6b6b);
            } else {
                ghostVoxel.material.color.setHex(CONFIG.GHOST_COLOR);
                ghostVoxel.material.emissive.setHex(CONFIG.GHOST_COLOR);
            }

            // 3. Trigger Logic
            const now = performance.now();

            // Debug Pinch States
            debugPinchState['Right'] = hands['Right'] ? detectPinch(hands['Right']) : false;
            debugPinchState['Left'] = hands['Left'] ? detectPinch(hands['Left']) : false;

            if (triggerHand && detectedHandCount >= 2) {
                // TWO HAND TRIGGER (Use Pinch on Trigger Hand)
                isDwelling = false;
                dwellRing.visible = false;

                const isTriggerPinching = detectPinch(triggerHand);

                // Handle click
                if (isTriggerPinching && !wasPinching && !blockPlacedThisPinch) {
                    blockPlacedThisPinch = true;

                    // Action happens at CURSOR position
                    if (isOverExisting) {
                        removeVoxel(ghostPosition.clone());
                    } else {
                        placeVoxel(ghostPosition.clone());
                    }
                }

                if (!isTriggerPinching) blockPlacedThisPinch = false;
                wasPinching = isTriggerPinching;
                isPinching = isTriggerPinching; // Update UI state

            } else {
                // ONE HAND TRIGGER (Use Dwell)

                // Dwell Logic (Same as before)
                const positionDistance = ghostPosition.distanceTo(dwellPosition);
                const positionStable = positionDistance < CONFIG.DWELL_TOLERANCE;

                if (!isOverExisting) {
                    if (positionStable && isDwelling) {
                        const elapsed = now - dwellStartTime;
                        dwellProgress = Math.min(1, elapsed / CONFIG.DWELL_TIME);
                        updateDwellIndicator(ghostPosition, dwellProgress);

                        if (dwellProgress >= 1) {
                            placeVoxel(ghostPosition.clone());
                            isDwelling = false;
                            dwellProgress = 0;
                            dwellRing.visible = false;
                            dwellPosition.set(9999, 9999, 9999);
                        }
                    } else if (positionStable && !isDwelling) {
                        isDwelling = true;
                        dwellStartTime = now;
                        dwellPosition.copy(ghostPosition);
                        dwellProgress = 0;
                    } else {
                        isDwelling = false;
                        dwellProgress = 0;
                        dwellPosition.copy(ghostPosition);
                        dwellRing.visible = false;
                    }
                } else {
                    // Over existing - 1 Hand Pinch to Remove
                    isDwelling = false;
                    dwellRing.visible = false;

                    const isOneHandPinching = detectPinch(cursorHand);
                    if (isOneHandPinching && !wasPinching && !blockPlacedThisPinch) {
                        blockPlacedThisPinch = true;
                        removeVoxel(ghostPosition.clone());
                    }
                    if (!isOneHandPinching) blockPlacedThisPinch = false;
                    wasPinching = isOneHandPinching;
                    isPinching = isOneHandPinching;
                }
            }
        }

    } else {
        // No hand detected
        ghostVoxel.visible = false;
        isPinching = false;
        wasPinching = false;
        blockPlacedThisPinch = false;
        smoothers = { 'Left': null, 'Right': null }; // Reset smoothing
    }

    // Update UI
    updateUI();
}

function updateUI() {
    // Hand detection status
    if (detectedHandCount > 0) {
        handStatusEl.textContent = `${detectedHandCount} Hand${detectedHandCount > 1 ? 's' : ''}`;
        handStatusEl.className = 'status-value active';
    } else {
        handStatusEl.textContent = 'None';
        handStatusEl.className = 'status-value inactive';
    }

    // Pinch status (Detailed)
    if (!handDetected) {
        pinchStatusEl.textContent = '—';
        pinchStatusEl.className = 'status-value inactive';
    } else {
        // Show L/R status
        const lState = debugPinchState['Left'] ? '✊' : '✋';
        const rState = debugPinchState['Right'] ? '✊' : '✋';

        if (detectedHandCount >= 2) {
            pinchStatusEl.textContent = `L:${lState} R:${rState}`;
        } else {
            // Single hand
            const state = (debugPinchState['Left'] || debugPinchState['Right']) ? '✊' : '✋';
            pinchStatusEl.textContent = `${state} Active`;
        }
        pinchStatusEl.className = 'status-value ' + (isPinching ? 'active' : 'inactive');
    }

    // FPS counter
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        const fps = Math.round(frameCount * 1000 / (now - lastFpsTime));
        fpsDisplayEl.textContent = fps;
        frameCount = 0;
        lastFpsTime = now;
    }
}

// ============================================
// ANIMATION LOOP
// ============================================

function animate() {
    requestAnimationFrame(animate);

    // Update hand tracking
    updateHandTracking();

    // Update particles
    if (particleSystem) particleSystem.update();

    // Update Gravity
    if (frameCount % CONFIG.GRAVITY_RATE === 0) {
        applyGravity();
    }

    // Update orbit controls
    controls.update();

    // Render scene
    renderer.render(scene, camera);
}

// ============================================
// EVENT HANDLERS
// ============================================

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================
// START APPLICATION
// ============================================

init().catch(error => {
    console.error('Failed to initialize:', error);
});
