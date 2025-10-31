# Privacy Policy for NeuMemo (Nemo)

Effective date: 2025-10-31

NeuMemo ("Nemo", "we", "our") is a Chrome extension that helps you organize browser tabs into sessions with AI‑generated summaries. This policy explains what data we collect, how we use it, and your choices.

If you have questions, contact the developer via the project repository issues: https://github.com/HebaShamardy/NeuMemo/issues

## What data we collect

Nemo collects or processes data only for functionality you initiate. Specifically:

### Website content
- Page text content from the tabs you choose to organize (to generate summaries and power search).

### Web history
- Tab titles and URLs of the tabs you choose to organize (to group into sessions and allow reopening/searching).

### User activity (google.com)
- Your current Google Search query is read on google.com to suggest a relevant past session. This is processed locally in the extension, not sent to our servers, and not transmitted to Google AI. It is not stored by Nemo.

Nemo does not collect: account information, payment data, contact lists, device identifiers, precise location, or personal profile information.

## How we use the data

We use the collected page content, titles, and URLs solely to:

- Generate concise summaries and group tabs into sessions
- Enable search and relevance suggestions within Nemo (e.g., a helpful hint on google.com)

We do not use data for advertising, marketing, or analytics.

## Processing and sharing

- Service provider processing (Website content and Web history only): To generate summaries and classifications, Nemo sends the captured page content, titles, and URLs to Google AI via the Firebase AI SDK. This transmission is used only to produce the requested AI output.
- User activity on google.com (search query): processed locally to display a suggestion; not transmitted to Google AI or any developer server; not stored.
- No selling: We do not sell your data.
- No third‑party advertising: We do not share your data for advertising or profiling.

## Storage and retention

- Local‑first: Your sessions and summaries are stored locally in your browser using IndexedDB. Nemo does not maintain a developer‑operated server database of your content.
- Transient processing: Data sent to Google AI via Firebase AI is transmitted over HTTPS for processing to produce summaries. Nemo does not control Google’s internal retention; consult Google’s policies for details about AI processing.
- Retention period: Your local data remains until you delete it.

## Your choices and controls

- Exclusions: You can add domains that should never be processed or summarized. Excluded sites are skipped when you capture tabs.
- Delete sessions: You can delete any session and its summaries.
- Clear all data: You can remove all saved sessions from Nemo’s local storage.

## Security

- Encryption in transit: Data is transmitted over HTTPS to Firebase/Google AI when you initiate summaries.
- Local storage: Data is stored locally by your browser. Protect access to your device and browser profile.

## Children’s privacy

Nemo is not directed to children and should not be used by individuals under the age required by applicable law without parental consent.

## Changes to this policy

We may update this policy from time to time. Changes will be posted in this repository with an updated effective date. Material changes will be noted in the release notes.

## Contact

For privacy questions, please open an issue in the repository: https://github.com/HebaShamardy/NeuMemo/issues
