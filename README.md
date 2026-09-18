# Kalodata Video Downloader

Chrome extension for downloading videos from Kalodata product pages.

The extension injects a small downloader panel into `kalodata.com`, detects the
Video & Ads table, builds direct video URLs from Kalodata video IDs, and downloads
the selected `.mp4` files from `live.kalocdn.com`.

## Features

- Detects Kalodata video rows from the Video & Ads table.
- Shows video title, revenue, views, sold quantity, publish date, and status.
- Downloads one video, selected videos, or all detected videos.
- Uses automatic warm-up before downloading.
- Retries failed downloads with backoff.
- Runs up to 3 concurrent downloads.
- Copies direct video links to the clipboard.
- Names downloaded files with the product ID when available.

## Project Structure

```text
.
|-- manifest.json   # Chrome extension manifest
|-- content.js      # Injected downloader UI, parser, and download manager
`-- README.md
```

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder:

   ```text
   kalodata-extension-SellifyX
   ```

5. Open or refresh a page on `https://www.kalodata.com/`.

## Usage

1. Go to a Kalodata product/listing page that contains the Video & Ads table.
2. Scroll until the video table is loaded.
3. Click the floating downloader button in the bottom-right corner.
4. Use the panel controls:

```text
Detect table      Re-scan the page for the video table
Refresh           Reload the currently visible video rows
Warm up all       Preload video URLs before download
Download selected Download checked videos
Download all      Download all detected videos
Close             Hide the panel
```

Each row also includes:

```text
DL       Download that video only
Copy     Copy the direct video URL
```

## Permissions

The extension requests:

- `activeTab` to interact with the active Kalodata page.
- `storage` for Chrome extension compatibility and future state storage.
- Host access to `https://www.kalodata.com/*`.
- Host access to `https://live.kalocdn.com/*` for video downloads.

## Notes

- The extension only runs on `https://www.kalodata.com/*`.
- If no videos appear, scroll the Kalodata table first, then click Refresh or
  Detect table.
- Downloads are created through the browser, so Chrome download settings still
  apply.
- If Kalodata changes its page structure, the selectors in `content.js` may need
  to be updated.

## Version

Current version: `2.0.0`

Author: `HaiMMO.me`
