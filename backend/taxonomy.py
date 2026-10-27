"""Definitions for previously saved category profiles; new preferences use direct intents."""

from dataclasses import dataclass


TAXONOMY_VERSION = "focusfeed-topics-v1"


@dataclass(frozen=True)
class Topic:
    id: str
    label: str
    definition: str
    includes: tuple[str, ...]
    excludes: tuple[str, ...]



TOPICS = (
    Topic(
        "topic.gaming",
        "Gaming",
        "Video games, gameplay, gaming culture, game development, or esports.",
        ("gameplay", "walkthroughs", "GTA 5", "Minecraft", "Fortnite", "Resident Evil", "Getting Over It", "esports"),
        ("real-world sports", "casino gambling", "game shows", "real vehicle vlogs"),
    ),
    Topic(
        "topic.music",
        "Music",
        "Songs, music performances, albums, artists, instruments, production, or music analysis.",
        ("music videos", "concerts", "covers", "beat making", "instrument lessons", "album reviews"),
        ("general celebrity news", "dance fitness", "non-musical podcasts"),
    ),
    Topic(
        "topic.film_tv",
        "Film & TV",
        "Movies, television, streaming series, anime, filmmaking, reviews, recaps, or screen analysis.",
        ("movie reviews", "TV recaps", "anime analysis", "trailers", "cinematography"),
        ("video-game cutscenes", "creator vlogs", "general celebrity gossip"),
    ),
    Topic(
        "topic.entertainment",
        "Entertainment & Celebrities",
        "Creator entertainment, comedy, challenges, reactions, celebrity coverage, or internet culture.",
        ("comedy", "reaction videos", "creator challenges", "celebrity interviews", "internet drama"),
        ("scripted film and TV analysis", "news reporting", "educational lectures"),
    ),
    Topic(
        "topic.news_politics",
        "News & Politics",
        "Current affairs, public policy, elections, geopolitics, civic issues, or news reporting.",
        ("breaking news", "political commentary", "elections", "international affairs", "public policy"),
        ("historical documentaries without current-affairs focus", "celebrity gossip", "business tutorials"),
    ),
    Topic(
        "topic.education",
        "Education & Careers",
        "Teaching, study, academic subjects, exams, professional skills, career advice, or job preparation.",
        ("tutorials", "lectures", "interview preparation", "DSA lessons", "language learning", "study advice"),
        ("product reviews without instruction", "pure entertainment", "general workplace vlogs"),
    ),
    Topic(
        "topic.technology",
        "Technology & Science",
        "Software, programming, computing, engineering, gadgets, scientific research, or technical explanation.",
        ("coding", "AI", "Kubernetes", "cybersecurity", "device reviews", "space", "engineering"),
        ("gaming content", "consumer finance", "non-technical product hauls"),
    ),
    Topic(
        "topic.business_finance",
        "Business & Finance",
        "Companies, entrepreneurship, careers in business, economics, investing, markets, or personal finance.",
        ("startups", "marketing", "stock markets", "budgeting", "economics", "business case studies"),
        ("gambling tips", "generic motivation", "shopping hauls"),
    ),
    Topic(
        "topic.health_fitness",
        "Health & Fitness",
        "Physical or mental health, medicine, nutrition, exercise, wellness, or fitness training.",
        ("workouts", "nutrition", "medical education", "mental health", "yoga", "running"),
        ("professional sports coverage", "beauty routines", "unverified miracle claims"),
    ),
    Topic(
        "topic.sports",
        "Sports",
        "Competitive physical sports, athletes, matches, training, analysis, or sports culture.",
        ("cricket", "football", "basketball", "motorsport", "match highlights", "sports analysis"),
        ("esports", "casual exercise", "vehicle reviews"),
    ),
    Topic(
        "topic.lifestyle",
        "Lifestyle, Food & Travel",
        "Daily life, relationships, fashion, beauty, cooking, home, hobbies, travel, or personal vlogs.",
        ("vlogs", "recipes", "travel guides", "fashion", "beauty", "DIY", "vehicle vlogs"),
        ("professional sports", "breaking news", "technical product instruction"),
    ),
    Topic(
        "topic.kids_family",
        "Kids & Family",
        "Content primarily made for children or family co-viewing, including animation, songs, stories, or learning.",
        ("nursery rhymes", "children's animation", "toy play", "family learning", "kids stories"),
        ("adult animation", "general parenting advice", "family vlogs aimed at adults"),
    ),
)

TOPICS_BY_ID = {topic.id: topic for topic in TOPICS}
