# Spot the Difference

A dependency-free browser game for creating and playing custom spot-the-difference puzzles. Puzzles can be authored from an already-edited image pair or generated crop-by-crop through a logged-in ChatGPT session.

## How it works

### Manual upload

1. Open `creator.html` and keep **Manual upload** selected.
2. Load a modified image plus its original.
3. Drag rectangles over every changed area.
4. Download the modified PNG and config JSON.

### AI with ChatGPT

1. Install the unpacked Chrome extension from `chrome-extension/` using `chrome://extensions` → **Developer mode** → **Load unpacked**.
2. Sign in at `https://chatgpt.com` in Chrome.
3. Serve this repository over localhost, open `creator.html`, and select **AI with ChatGPT**.
4. Upload one original image and select **Suggest regions**.
5. Review all ten rectangles and edit instructions. You can remove, redraw, download, or manually replace any crop.
6. Select **Generate pending edits**. The extension opens a dedicated ChatGPT tab and processes one padded crop in a fresh regular conversation at a time. When ChatGPT returns an image card, the extension opens its full-size viewer and reads the resulting asset back into the creator.
7. Inspect the composited modified image, then download the modified PNG and config JSON.

After changing any file in `chrome-extension/`, select **Reload** on the extension card in `chrome://extensions` before testing again. The creator reports attachment, submission, and response-wait stages; if a request stalls, inspect the visible temporary ChatGPT tab and retry after the creator watchdog resets it.

The full image is uploaded to ChatGPT only for region analysis, which uses a temporary chat. Because ChatGPT image editing is unavailable in Temporary Chat, each image-editing request uses a fresh regular chat containing only one padded crop; these edit chats can appear in ChatGPT history. Returned crops are resized to their original crop geometry, clipped to a modest safe area around the selected rectangle, feathered at the edges, and composited on a canvas with the original image dimensions. The extra compositing room lets a connected feature such as a hat finish naturally across the edge of the puzzle's clickable rectangle. The exported config stores that larger composited area separately, so finding a difference reveals the original beneath the entire generated patch while the user-drawn rectangle remains the click target.

Region suggestions are validated before they enter the creator. If ChatGPT returns an undersized, out-of-bounds, oversized, or substantially overlapping rectangle, the creator keeps every valid suggestion and asks for only the missing replacements in the same analysis chat. The rejection reasons and accepted rectangles are included so the replacements can correct the validation issue without duplicating existing targets.

Blank edit instructions rotate through five prompt families—clean removal, color/material change, addition, swap/replacement, and a gently silly transformation—twice across a ten-region puzzle. Prompts explicitly avoid mustache and facial-hair jokes while keeping each change noticeable and believable in the scene.

AI mode presents a three-step creator workflow: upload one photo, generate the complete puzzle, then download the modified PNG and config JSON together. Validated suggestions proceed directly into crop generation without an approval step. Region editing, retry controls, individual downloads, import tools, and diagnostics remain available under Advanced options. When people are present, prompts can include occasional harmless visual jokes involving clothing, accessories, or cleanly omitted small features while explicitly avoiding injury, distress, offensive content, or grotesque results.

AI suggestions must now be visible at normal full-image viewing size. The creator rejects undersized regions and instructions aimed at rings, pins, magnets, punctuation, single shoelaces, isolated buttons, and similar micro-details, then requests larger replacements. In AI mode the creator shows one clean generated preview without rectangle overlays or drag editing. Step 2 includes a weighted percentage bar: analysis occupies the opening portion and the ten image edits share the remaining progress according to their upload, submission, generation, and completion stages.

To play, open `player.html`, load the modified image, original image, and exported JSON, then select **Load game**.

Both images must use the same pixel dimensions. Puzzle regions are stored as normalized coordinates, so they stay aligned when the game is resized.

The player is optimized for a large landscape touchscreen: its classroom mode keeps both images in one viewport, uses large controls, blocks guesses until **START** is pressed, and offers an explicit full-screen toggle.

## Run locally

The app has no build step. AI Bridge detection requires an allowed web origin, so serve the folder locally:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

Run the dependency-free protocol and routing tests with:

```sh
npm test
```

## Project structure

- `index.html` — landing page
- `creator.html` / `creator.js` — manual and ChatGPT-assisted puzzle authoring
- `player.html` — game setup, scoring, hints, and play
- `chrome-extension/` — Manifest V3 bridge for the visible ChatGPT web interface

## Current config format

Creator exports version 3 JSON containing the source image dimensions, number of required finds, normalized clickable rectangle regions, and—when an AI patch extends beyond a clickable rectangle—separate normalized reveal bounds. The player also accepts version 3 configs without reveal bounds and migrates older version 2 circle-based configs when loaded.

## Privacy and limitations

- The extension does not read browser cookies or call private ChatGPT APIs. It automates the visible, logged-in ChatGPT page after an explicit creator action.
- Original images and crops are sent to ChatGPT. Do not use images you are not permitted to upload.
- ChatGPT may refuse a request, return no image, or make a larger change than requested. Review every result; failed regions remain retryable and each region supports manual crop download/upload.
- Built-in image editing can take several minutes. The bridge reacts as soon as the generated-image card appears, with a five-minute failure ceiling and a six-minute creator watchdog. **Cancel current job** remains available throughout.
- ChatGPT’s website is not a stable automation API. If its composer, upload, send, response, or image markup changes, update the centralized selector list at the top of `chrome-extension/chatgpt-adapter.js`.
- The extension currently supports localhost, `127.0.0.1`, and this repository’s GitHub Pages path. Add other trusted creator origins explicitly to `manifest.json`; avoid broad page permissions.
