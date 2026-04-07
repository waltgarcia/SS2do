# SS2do: Screenshot-to-Action Workflow

This repository is built around one practical idea: screenshots are usually reminders in disguise.

A screenshot can mean "read this paper", "follow up on this message", "check this invoice", or "come back to this later". The functionality here turns that passive image into an explicit next step and keeps that next step visible in a bucketed queue.

## What this functionality does

- Accepts input from gallery, camera, and Android share sheet
- Extracts text from the image with OCR (Spanish + English)
- Suggests query options as clickable choices (without auto-filling)
- Lets you save using only the query if needed
- Keeps an actionable queue grouped by action buckets
- Stores a thumbnail of the screenshot with each actionable item
- Keeps a resolved history log over time
- Preserves data locally on device (no backend required)

## Why this exists

Most people capture information quickly and postpone decisions. Over time, screenshots become a silent backlog with no accountability. This workflow creates accountability by forcing each captured image to end in a concrete action or follow-up.

## Included test APK

A debug APK is included so anyone can test without building first:

- Path: releases/SS2do-debug.apk

If Android blocks installation, enable install from unknown sources for your file manager.

## Repository structure

- index.html, app.js, styles.css: core web functionality
- android/: Capacitor Android project
- releases/SS2do-debug.apk: installable debug build for quick testing

## Security and privacy notes

- Input validation for image type and size
- Content Security Policy in HTML
- Escaping before rendering OCR/user text
- Local-first storage in browser localStorage
- No cloud upload pipeline in this version

## Running locally (web)

1. Open a terminal in this folder
2. Run: python3 -m http.server 8080
3. Open: http://localhost:8080

## Building APK locally

Prerequisites:

- Node.js and npm
- Android Studio with SDK installed
- android/local.properties with your sdk.dir

Build command:

1. npm install
2. npm run build:apk:debug

Output APK:

- android/app/build/outputs/apk/debug/app-debug.apk

## Practical testing flow

1. Take screenshot on phone
2. Share it directly to SS2do
3. Tap Analyze Screenshot
4. Edit query/action if needed
5. Save to Actionables
6. Verify it appears in the correct action bucket with thumbnail

## Scope of this version

This is an MVP focused on execution discipline and traceability. It is intentionally simple: local storage, lightweight OCR heuristics, and direct actionable tracking from captured information.
