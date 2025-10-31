# NeuMemo Chrome Extension

NeuMemo is a Chrome extension designed to collect and organize information from your browsing sessions. It captures the titles, URLs, and text content of open tabs and stores them locally for easy access and organization.

## Features

- Collects tab data (title, URL, content) from all open tabs.
- Saves collected data to IndexedDB for offline access.
- Displays collected tabs and rejected tabs in a user-friendly viewer interface.
- Allows users to collect data from the current session on demand.
- Settings page to exclude specific site domains from all processing and storage.

## File Overview

- **background.js**: The background script that manages tab data collection and storage.
- **content.js**: The content script that runs on web pages to gather tab information.
- **viewer.html**: The HTML structure for the viewer interface displaying collected and rejected tabs.
- **viewer.js**: The JavaScript logic for populating the viewer with data from IndexedDB.
- **manifest.json**: The configuration file for the Chrome extension.

## Installation

1. Download or clone the repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode" in the top right corner.
4. Click on "Load unpacked" and select the `neumemo` directory.
5. The NeuMemo extension should now be installed and ready to use.

## Usage

- Click on the NeuMemo extension icon in the Chrome toolbar to open the viewer.
- Use the "Collect" button in the viewer to gather data from the currently open tabs.
- View the collected tabs and any rejected tabs in their respective tables.

### Exclude sites (Settings)

If there are websites you don't want NeuMemo to analyze or store (e.g., music or personal sites), you can exclude them:

1. Open Chrome's extensions page: `chrome://extensions/`.
2. Find NeuMemo and click "Details".
3. Click "Extension options" to open the settings.
4. Add a domain like `spotify.com` or `https://music.youtube.com` and click Add.

Notes:
- Adding `example.com` will exclude that domain and all its subdomains (e.g., `www.example.com`, `app.example.com`).
- Existing entries already in the local database are not automatically removed, but newly collected tabs from excluded domains will be ignored.

## Contributing

Contributions are welcome! If you have suggestions for improvements or new features, please open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.