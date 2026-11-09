# OwnFeed

OwnFeed is a Chrome extension for desktop YouTube. It helps users control recommendations by topic, manually block channels, and hide distracting parts of YouTube. OwnFeed is an independent project and is not affiliated with or endorsed by YouTube or Google.

Website: https://ownfeed.tech/

## Availability

OwnFeed is available as a manual installation for desktop Chrome: download the ZIP from the website, extract it, and use Load unpacked in Developer mode at chrome://extensions. The website contains an illustrative interactive demo, not a connection to a visitor's actual YouTube feed. Filtering can make mistakes, and YouTube changes can affect compatibility.

## Free controls

Layout controls can hide Shorts, comments, recommendations, and other page elements. Manual channel blocking and layout controls work without an account or AI classifier.

## AI topic filtering and Focus

In General mode, OwnFeed hides recommendations matching topics the user wants to skip. In Focus mode, it keeps recommendations matching a chosen objective, with an optional timed session. Topics preserve the user's intent: “movie reviews” is intended to match reviews rather than all movie-related content. Users can change topics, correct missed videos, unblock content, pause filtering, or end a Focus session.

AI filtering uses your own TypeSafe/Jev API key with access to jev-1.13.0. Requests go directly from the extension background worker to TypeSafe. No OwnFeed account, hosted backend, or subscription is needed. The key is kept in trusted browser session storage and must be entered again after Chrome restarts or OwnFeed reloads or updates.

## Pricing

OwnFeed is free, including topic filtering, Focus sessions, and feedback controls. TypeSafe bills provider usage to your own account. OwnFeed does not collect subscription payments.

## Installation availability

Download https://ownfeed.tech/downloads/ownfeed-0.29.2.zip, unzip it into a folder, enable Developer mode at chrome://extensions and choose Load unpacked. Select the extracted folder, enter your TypeSafe key in OwnFeed, and refresh YouTube. No local server is needed.

## Data handling

Preferences are kept in the browser profile. Optional AI filtering sends chosen topics and relevant video or channel text directly to TypeSafe using your own API key. The key is not sent to an OwnFeed-operated server. AI classification requires an internet connection. See the [Privacy Policy](https://ownfeed.tech/privacy) for details and the [Terms of Service](https://ownfeed.tech/terms) for preview limitations.

## Source

The source repository is https://github.com/alokdangre/FocusFeed. The repository retains its historical FocusFeed name; the product is called OwnFeed.
