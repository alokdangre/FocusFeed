from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

try:
    from .taxonomy import TAXONOMY_VERSION, TOPICS_BY_ID
except ImportError:  # Lambda loads modules from CodeUri as top-level modules.
    from taxonomy import TAXONOMY_VERSION, TOPICS_BY_ID  # type: ignore[no-redef]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)


FilterMode = Literal["general", "focus"]
ObjectiveStatus = Literal["ready_for_confirmation", "needs_clarification"]
INTENT_VERSION = "focusfeed-intent-v1"


class TypedObjective(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=160)
    content_type: Literal["topic"] = Field(alias="contentType")
    match_scope: Literal["taxonomy", "intent"] = Field(default="taxonomy", alias="matchScope")
    validation_version: str | None = Field(default=None, alias="validationVersion")
    taxonomy_id: str | None = Field(default=None, alias="taxonomyId", min_length=1, max_length=80)
    taxonomy_version: str | None = Field(default=None, alias="taxonomyVersion", min_length=1, max_length=80)
    source_text: str | None = Field(default=None, alias="sourceText", max_length=160)

    @model_validator(mode="after")
    def topic_must_be_canonical(self) -> "TypedObjective":
        if self.match_scope == "intent":
            if self.validation_version != INTENT_VERSION:
                raise ValueError("Validate this intent before saving it")
            if self.taxonomy_id is not None or self.taxonomy_version is not None:
                raise ValueError("Direct intents must not be replaced by taxonomy topics")
            if self.source_text is not None and self.source_text != self.text:
                raise ValueError("Direct intent text must preserve the validated wording")
            return self
        if self.taxonomy_version != TAXONOMY_VERSION:
            raise ValueError(f"taxonomyVersion must be {TAXONOMY_VERSION}")
        if self.taxonomy_id not in TOPICS_BY_ID:
            raise ValueError("taxonomyId is not part of the active taxonomy")
        if self.id != self.taxonomy_id:
            raise ValueError("objective id must equal taxonomyId")
        if self.text != TOPICS_BY_ID[self.taxonomy_id].label:
            raise ValueError("objective text must equal the canonical taxonomy label")
        return self


class GoalProfile(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    version: int = Field(ge=1)
    mode: FilterMode
    objectives: list[TypedObjective] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def objectives_must_be_unique(self) -> "GoalProfile":
        ids = [objective.id for objective in self.objectives]
        texts = [objective.text.casefold() for objective in self.objectives]
        if len(ids) != len(set(ids)):
            raise ValueError("objective ids must be unique")
        if len(texts) != len(set(texts)):
            raise ValueError("objective text values must be unique")
        taxonomy_ids = [objective.taxonomy_id for objective in self.objectives if objective.taxonomy_id]
        if len(taxonomy_ids) != len(set(taxonomy_ids)):
            raise ValueError("taxonomyId values must be unique")
        return self


class ObjectiveClassificationRequest(StrictModel):
    request_id: str = Field(alias="requestId", min_length=8, max_length=100)
    mode: FilterMode
    objectives: list[str] = Field(min_length=1, max_length=8)

    @field_validator("objectives")
    @classmethod
    def validate_objectives(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            item = value.strip()
            if not item or len(item) > 160:
                raise ValueError("objectives must contain 1-160 characters")
            key = item.casefold()
            if key not in seen:
                seen.add(key)
                normalized.append(item)
        if not normalized:
            raise ValueError("at least one objective is required")
        return normalized


class ObjectiveAssessment(StrictModel):
    objective_id: str = Field(alias="objectiveId", min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=160)
    content_type: Literal["topic", "unclear"] = Field(alias="contentType")
    status: ObjectiveStatus
    understood_probability: float = Field(alias="understoodProbability", ge=0, le=1)
    matchable_probability: float = Field(alias="matchableProbability", ge=0, le=1)
    validated_objective: TypedObjective | None = Field(default=None, alias="validatedObjective")
    reason: str = Field(min_length=1, max_length=400)


class VideoCandidate(StrictModel):
    video_id: str = Field(alias="videoId", min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=300)
    channel: str = Field(default="", max_length=200)
    channel_id: str | None = Field(default=None, alias="channelId", max_length=100)
    duration: str | None = Field(default=None, max_length=30)
    is_short: bool = Field(default=False, alias="isShort")
    is_live: bool = Field(default=False, alias="isLive")
    is_premiere: bool = Field(default=False, alias="isPremiere")
    description_snippet: str | None = Field(default=None, alias="descriptionSnippet", max_length=1000)


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


class ObjectiveMatch(StrictModel):
    objective_id: str = Field(alias="objectiveId", min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=160)
    content_type: Literal["topic"] = Field(alias="contentType")
    match_probability: float = Field(alias="matchProbability", ge=0, le=1)


MatchOutcome = Literal["match", "no_match", "uncertain"]


class VideoAssessment(StrictModel):
    video_id: str = Field(alias="videoId", min_length=1, max_length=80)
    objective_matches: list[ObjectiveMatch] = Field(alias="objectiveMatches", min_length=1, max_length=12)
    outcome: MatchOutcome
    evidence: list[str] = Field(default_factory=list, max_length=3)
    reason: str = Field(min_length=1, max_length=400)

    @field_validator("evidence")
    @classmethod
    def validate_evidence(cls, values: list[str]) -> list[str]:
        return [value.strip()[:180] for value in values if value.strip()]


class ClassifierInfo(StrictModel):
    provider: Literal["typesafe-jev"]
    model: str
    prompt_version: str = Field(alias="promptVersion")


class TimingInfo(StrictModel):
    total_ms: int = Field(alias="totalMs", ge=0)


class ObjectiveClassificationResponse(StrictModel):
    request_id: str = Field(alias="requestId")
    classifier: ClassifierInfo
    objectives: list[ObjectiveAssessment]
    timing: TimingInfo
    diagnostics: dict = Field(default_factory=dict)


class ClassificationResponse(StrictModel):
    request_id: str = Field(alias="requestId")
    classifier: ClassifierInfo
    assessments: list[VideoAssessment]
    timing: TimingInfo
    diagnostics: dict = Field(default_factory=dict)
