from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class GoalProfile(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    version: int = Field(ge=1)
    goal: str = Field(min_length=3, max_length=500)
    useful_topics: list[str] = Field(
        default_factory=list,
        alias="usefulTopics",
        max_length=20,
    )
    unwanted_topics: list[str] = Field(
        default_factory=list,
        alias="unwantedTopics",
        max_length=20,
    )
    exceptions: list[str] = Field(default_factory=list, max_length=20)
    languages: list[str] = Field(default_factory=lambda: ["English"], max_length=10)
    mode: Literal["focus", "balanced"]

    @field_validator("useful_topics", "unwanted_topics", "exceptions", "languages")
    @classmethod
    def validate_short_list_items(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            item = value.strip()
            if not item or len(item) > 120:
                raise ValueError("list items must contain 1-120 characters")
            key = item.casefold()
            if key not in seen:
                seen.add(key)
                normalized.append(item)
        return normalized


class VideoCandidate(StrictModel):
    video_id: str = Field(alias="videoId", min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=300)
    channel: str = Field(default="", max_length=200)
    channel_id: str | None = Field(default=None, alias="channelId", max_length=100)
    duration: str | None = Field(default=None, max_length=30)
    is_short: bool = Field(default=False, alias="isShort")
    is_live: bool = Field(default=False, alias="isLive")
    is_premiere: bool = Field(default=False, alias="isPremiere")
    description_snippet: str | None = Field(
        default=None,
        alias="descriptionSnippet",
        max_length=1000,
    )


class ClassificationRequest(StrictModel):
    request_id: str = Field(alias="requestId", min_length=8, max_length=100)
    profile: GoalProfile
    videos: list[VideoCandidate] = Field(min_length=1, max_length=12)

    @field_validator("videos")
    @classmethod
    def video_ids_must_be_unique(cls, videos: list[VideoCandidate]) -> list[VideoCandidate]:
        ids = [video.video_id for video in videos]
        if len(ids) != len(set(ids)):
            raise ValueError("videoId values must be unique within a request")
        return videos


ContentPurpose = Literal[
    "tutorial",
    "practice",
    "news",
    "commentary",
    "entertainment",
    "music",
    "other",
    "unclear",
]
GoalRelevance = Literal["directly_useful", "supporting", "unrelated", "unclear"]
UnwantedMatch = Literal["yes", "no", "unclear"]
EvidenceSufficiency = Literal["sufficient", "insufficient"]


class VideoAssessment(StrictModel):
    video_id: str = Field(alias="videoId", min_length=1, max_length=80)
    topics: list[str] = Field(default_factory=list, max_length=6)
    content_purpose: ContentPurpose = Field(alias="contentPurpose")
    goal_relevance: GoalRelevance = Field(alias="goalRelevance")
    unwanted_match: UnwantedMatch = Field(alias="unwantedMatch")
    evidence_sufficiency: EvidenceSufficiency = Field(alias="evidenceSufficiency")
    evidence: list[str] = Field(default_factory=list, max_length=3)
    reason: str = Field(min_length=1, max_length=400)

    @field_validator("topics")
    @classmethod
    def validate_topics(cls, values: list[str]) -> list[str]:
        return [value.strip()[:80] for value in values if value.strip()]

    @field_validator("evidence")
    @classmethod
    def validate_evidence(cls, values: list[str]) -> list[str]:
        return [value.strip()[:180] for value in values if value.strip()]


class ClassificationBatch(StrictModel):
    assessments: list[VideoAssessment] = Field(default_factory=list, max_length=12)


class ClassifierInfo(StrictModel):
    provider: Literal["amazon-bedrock"]
    model: str
    prompt_version: str = Field(alias="promptVersion")


class TimingInfo(StrictModel):
    total_ms: int = Field(alias="totalMs", ge=0)


class ClassificationResponse(StrictModel):
    request_id: str = Field(alias="requestId")
    classifier: ClassifierInfo
    assessments: list[VideoAssessment]
    timing: TimingInfo
    diagnostics: dict = Field(default_factory=dict)
