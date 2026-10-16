# Dyna Ops: Encord Automations

Internal Chrome MV3 extension for Encord label editor. Automates repetitive operator work for robot model training.

Currently saves ~70 hours/week for our team of 21.

## Architecture

`background.js` — comprises actions clicks, context menu, and message routing

`layout-ops.js` — shared control panel running save/restore/ toggle logic

`content.js` — in page camera-layout script. Discovers and manipulates mosaic tiles

`page-world.js` — Runs directly in the page's React component tree. Captures the mosaic layout tree and applies saved tree back into React.

## Design Choices

Built as an extension with its own UI, promoting separation of concerns.

Encord layout preferences and flags are saved locally on chrome.storage.local, keeping system architecture simple and scoped to the local profile.

### Camera layout

Encord mosaic layout tree is captured in the page's MAIN world (camera position, width, height) to be restored on new episodes. Guard when saved episode's default camera set doesn't match current one.

### Steps scroll

Detects new unlabeled range, and scrolls to the next step (maxDefined + 1) that requires annotation.

### Grade-step annotate

Drives labeling directly from Encord's UI (clicks, selection, inputs). The extension has no access to server-side label writes except through the same UI as the operator. Auto is off by default; must be manually turned on for corresponding projects.

This product exemplifies taking what you can get (editor DOM, Chrome extensions APIs) and extracting as much value as possible.
