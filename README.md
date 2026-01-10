# VoxelFlow - Hand Controlled Voxel Editor

An interactive 3D voxel editor controlled entirely by hand gestures using your webcam. Built with Three.js and Google MediaPipe.

![Demo](https://via.placeholder.com/800x450?text=CubeStack+VR+screenshot)

## 🎮 Controls

| Gesture | Action |
|Coordination| Result |
|---|---|
| **Right Hand Point** | Aim (Move Cursor) |
| **Left Hand Pinch** | Place / Remove Block |
| **Two Hands** | Advanced Interaction |

## ✨ Features

- **Top-Stacking Magnetism**: Easily build towers by aiming near the top edge of existing blocks.
- **Physics Gravity**: Toggle gravity to make unsupported blocks crumble and fall.
- **Color Palette**: Choose from 8 vibrant colors.
- **Reset**: Instantly clear the scene with a double-click on the trash icon.
- **Hand Tracking**: Real-time skeletal tracking with detailed UI feedback (L/R Hand status).

## 🚀 Getting Started

1. **Prerequisites**: A computer with a webcam.
2. **Install**: No installation required! Just serve the HTML file.
3. **Run**:
   ```bash
   npx http-server . -p 8080
   ```
4. **Open**: Navigate to `http://localhost:8080/index.html`.

## 🛠️ Technology Stack
- **Three.js**: 3D Rendering Engine
- **MediaPipe HandLandmarker**: Computer Vision & Hand Tracking
- **Vanilla JS**: Logic & Interaction

## ⚠️ Troubleshooting
- **Reset button not working?** Refresh the page (Ctrl+Shift+R) to clear old cache.
- **Hand not detected?** Ensure good lighting and that your hand is visible to the camera.

---
*Created with ❤️ by Antigravity*
