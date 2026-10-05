# 🎬 SyncCinema - Loklok-style Watch Together Player

A synchronized video player designed for couples & friends to watch movies together across PC and Android, optimized for **slow internet connections**, with **zero buffering**, **in-app voice calling**, and a **"Jump to Partner" sync button**.

---

## 🌟 Key Features

1. **⚡ "Jump to Partner" Sync (Your Core Feature)**
   - Real-time timestamp display for both of you side-by-side (`You: 01:15` vs `Partner: 03:40`).
   - If Person A is at 01:00 and Person B is at 03:00, clicking **"Jump to Partner"** instantly seeks your player to 03:00 (and vice versa).
   - Pausing or playing on either device instantly synchronizes the other.

2. **🚫 100% Zero-Buffering Mode (Slow Internet Hack)**
   - **Pre-download option**: In the Movie Library, your partner can tap **"Save" (Download)** on her Android phone.
   - Once saved, she clicks **"📁 Local File (Zero Buffering)"** in the player and selects it.
   - The movie plays directly from her phone storage with **0% buffering or lag**, while only a few bytes of play/pause sync commands travel over WebSockets!

3. **📞 Built-in Voice Call (WebRTC Peer-to-Peer)**
   - Talk to each other directly through the player while watching.
   - Includes **Microphone Mute / Unmute** and an independent **Partner Voice Volume** slider so the movie doesn't drown her out.
   - Uses Google's free public STUN servers — **100% Free Forever**, $0.00 cost.

4. **📂 Movie Library (Upload & Delete to Save PC Disk Space)**
   - Drag & drop or upload `.mp4`, `.mkv`, `.webm` movies from your PC.
   - Delete finished movies with 1 click to free up your PC storage.
   - HTTP Range streaming (206 Partial Content) allows smooth scrubbing/seeking.

5. **📱 Mobile-First PWA (Feels like an Android APK)**
   - She opens the link in Chrome on Android.
   - Tap **⋮ (Menu) -> "Add to Home screen"**. It gets an app icon and opens full-screen without browser bars, just like a native APK.

---

## 🚀 Quick Start Guide

### 1. Install Dependencies
Open PowerShell or Terminal in this folder (`C:\rattanindia\myProject\video`):
```bash
npm install
```

### 2. Start the Application
```bash
npm run dev
```
The server will start on: **`http://localhost:3000`**

---

## 🌐 How She Connects From Her Android Phone (100% Free)

You have two instant free ways to connect her phone:

### Method A: Free Cloudflare Tunnel (Recommended - Works Anywhere)
No router port forwarding, no sign-up, completely free:
1. In a new PowerShell window, run:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
2. It will output a free HTTPS link, like:
   `https://random-words.trycloudflare.com`
3. Send this link to her on WhatsApp/Telegram.
4. When she opens it, enter the same **Room Code** (e.g. `our-room`), and you are connected!

### Method B: Same Wi-Fi Network
If her phone is connected to the same home Wi-Fi as your PC:
1. Find your PC's local IP address (run `ipconfig` in PowerShell, look for `IPv4 Address`, e.g. `192.168.1.5`).
2. She opens `http://192.168.1.5:3000` on her Android phone browser.

---

## 💡 How to Watch Without Any Buffering on Slow Internet

1. **Step 1:** Upload the movie into SyncCinema from your PC in India.
2. **Step 2:** She opens the room on her Android phone in the Philippines and taps **"Save" (Download)** next to the movie in the Movie Library.
3. **Step 3:** In the video player, she clicks **"📁 Local File (Zero Buffering)"** and selects the downloaded video from her Android "Downloads" folder.
4. **Step 4:** You hit Play — both of your players are perfectly locked in sync, and her video will never buffer because the file is playing locally!

---

## 🌏 India ↔ Philippines Connection Guide (Render vs. Cloudflare Tunnel)

### ⚠️ Why Render Free Tier is NOT recommended for Video Files:
1. **Ephemeral Filesystem**: Render's free tier wipes all uploaded files whenever the app restarts or sleeps (after 15 mins of inactivity). Any uploaded movie in `movies/` will be deleted.
2. **512 MB RAM Limit**: Uploading multi-GB movie files directly to Render free tier will cause **Out-Of-Memory (OOM)** errors or timeouts.

### 🚀 Recommended Setup: Your PC in India + Free Cloudflare Tunnel (100% Free & Unlimited Storage)

#### Step-by-Step Instructions:
1. **Start SyncCinema on your PC in India**:
   ```bash
   npm run dev
   ```
2. **Expose your PC securely over HTTPS using Cloudflare**:
   In a second PowerShell window, run:
   ```bash
   npx cloudflared tunnel --url http://localhost:3000
   ```
   *Cloudflare will generate a public HTTPS URL (e.g. `https://your-custom-name.trycloudflare.com`).*

3. **Share Link & Upload**:
   - Send the `trycloudflare.com` link to your girlfriend on WhatsApp.
   - Upload the movie on your PC (or place `.mp4` / `.mkv` files directly inside `movies/` directory).

4. **She Downloads to Her Android Phone**:
   - She opens the link in Chrome on her phone in the Philippines.
   - In the **Movie Library**, she taps **"Save"** (Download). The video downloads straight from your PC hard drive over Cloudflare's global edge network.

5. **Select Local File & Sync**:
   - Once saved to her Android phone, she taps **"📁 Local File (Zero Buffering)"** in SyncCinema and selects the downloaded video file.
   - Enter room `our-room` and press Play — **0% Buffering, 100% Locked-in Sync!**

