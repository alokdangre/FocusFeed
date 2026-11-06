# OwnFeed

OwnFeed is a Chrome extension for desktop YouTube. It helps users control recommendations by topic, manually block channels, and hide distracting parts of YouTube. OwnFeed is an independent project and is not affiliated with or endorsed by YouTube or Google.

Website: https://ownfeed.tech/

## Availability

OwnFeed is in development. Public extension downloads and a Chrome Web Store release are not available yet. The website contains an illustrative interactive demo, not a connection to a visitor's actual YouTube feed. Filtering can make mistakes, and YouTube changes can affect compatibility.

## Free controls

Layout controls can hide Shorts, comments, recommendations, and other page elements. Manual channel blocking and layout controls work without an account or AI classifier.

## AI topic filtering and Focus

In General mode, OwnFeed hides recommendations matching topics the user wants to skip. In Focus mode, it keeps recommendations matching a chosen objective, with an optional timed session. Topics preserve the user's intent: “movie reviews” is intended to match reviews rather than all movie-related content. Users can change topics, correct missed videos, unblock content, pause filtering, or end a Focus session.

AI filtering requires a configured backend in the developer preview. Local developer testing can run without hosted sign-in, but AI requests still go to the configured provider. Hosted AI filtering is planned to require an account and active Pro access when available.

## Pricing

Layout controls and manual channel blocking are free. Hosted Pro is coming soon. Its planned price is $4.99 per month and may change. The planned Pro features include AI topic filtering, timed Focus sessions, and feedback to refine filters. Checkout and paid subscriptions are not available in the current preview.

## Installation availability

Public downloads are not available yet. You can try the illustrative website demo while the public release is being prepared.

## Data handling

Preferences are kept in the browser profile. Optional AI filtering sends chosen topics and relevant video or channel text to the configured backend and TypeSafe provider. A local backend does not make AI classification offline. See the [Privacy Policy](https://ownfeed.tech/privacy) for details and the [Terms of Service](https://ownfeed.tech/terms) for preview limitations.

## Source

The source repository is https://github.com/alokdangre/FocusFeed. The repository retains its historical FocusFeed name; the product is called OwnFeed.
