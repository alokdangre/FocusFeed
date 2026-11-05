import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from channel_classifier import ChannelClassificationRequest, build_channel_request, classify_channel
from classifier import TypeSafeResponseError
import handler


def payload(topic="movie reviews except documentaries"):
    return {"requestId": "channel-test-123", "profile": {"id": "general", "version": 1, "mode": "general",
        "objectives": [{"id": "intent-movies", "text": topic, "contentType": "topic", "matchScope": "intent", "validationVersion": "focusfeed-intent-v1"}]},
        "channel": {"channelId": "UCcreator123456", "title": "Reviewer", "description": "Movie reviews",
                    "uploads": [{"videoId": f"video-{i}", "title": f"Film {i} review"} for i in range(12)]}}


def evaluator(dominant=.98):
    return lambda request: {"model": "jev-1.13.0", "answers": {
        "o0_dominant": {"type": "noul", "noul": dominant}}, "usage": {"input_tokens": 100}}


class ChannelTests(unittest.TestCase):
    def test_dominant_pattern_can_block_channel_despite_occasional_exception(self):
        request = ChannelClassificationRequest.model_validate(payload())
        sent = build_channel_request(request)
        self.assertIn("per-video exception does not prevent", sent["questions"]["o0_dominant"]["instructions"]["question"])
        self.assertEqual(sent["state"]["objectives"][0]["intent"], "movie reviews except documentaries")
        result = classify_channel(request, evaluator())
        self.assertTrue(result.matches[0]["blockChannel"])
        self.assertEqual(result.diagnostics["evidenceMode"], "uploads")

    def test_dominance_boundary_and_sample_minimum(self):
        for dominant, count, blocked in [(.5, 8, True), (.6, 12, True), (.499, 12, False), (.98, 3, False)]:
            data = payload(); data["channel"]["uploads"] = data["channel"]["uploads"][:count]
            result = classify_channel(ChannelClassificationRequest.model_validate(data), evaluator(dominant))
            self.assertEqual(result.matches[0]["blockChannel"], blocked)
            self.assertNotIn("sufficientProbability", result.matches[0])
            self.assertEqual(result.diagnostics["questionCount"], 1)

    def test_duplicate_uploads_do_not_establish_a_large_sample(self):
        data = payload(); data["channel"]["uploads"] = [data["channel"]["uploads"][0]] * 12
        self.assertFalse(classify_channel(ChannelClassificationRequest.model_validate(data), evaluator()).matches[0]["blockChannel"])

    def test_narrow_topic_can_map_to_broader_topic_without_uploads(self):
        data = payload("movies and anything about them"); data["channel"].update(uploads=[], knownTopics=["movie roasting"])
        request = ChannelClassificationRequest.model_validate(data)
        sent = build_channel_request(request)
        self.assertEqual(sent["state"]["channel"]["uploads"], [])
        self.assertEqual(sent["state"]["channel"]["known_topics"], ["movie roasting"])
        self.assertEqual(set(sent["questions"]), {"o0_dominant"})
        self.assertIn("movies in general do not imply movie reviews", sent["questions"]["o0_dominant"]["instructions"]["question"])
        self.assertTrue(classify_channel(request, evaluator()).matches[0]["blockChannel"])

    def test_summary_uses_dominance_only_and_rejects_repeated_uploads(self):
        data = payload(); data["channel"].update(uploads=[], knownTopics=["movie reviews"])
        result = classify_channel(ChannelClassificationRequest.model_validate(data), evaluator(.5))
        self.assertTrue(result.matches[0]["blockChannel"])
        data["channel"]["uploads"] = payload()["channel"]["uploads"]
        with self.assertRaises(ValueError):
            ChannelClassificationRequest.model_validate(data)

    def test_invalid_partial_probabilities_fail_instead_of_creating_rules(self):
        for bad in [True, None, float("nan"), 1.1]:
            with self.subTest(value=bad), self.assertRaises(TypeSafeResponseError):
                classify_channel(ChannelClassificationRequest.model_validate(payload()), evaluator(bad))

    def test_channel_route_is_validated_and_distinct_from_video_route(self):
        event = {"rawPath": "/channels/classify", "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(payload())}
        result = classify_channel(ChannelClassificationRequest.model_validate(payload()), evaluator())
        with patch.object(handler, "classify_channel", return_value=result) as classify, patch.object(handler, "classify_videos") as video:
            response = handler.lambda_handler(event, None)
        self.assertEqual(response["statusCode"], 200); classify.assert_called_once(); video.assert_not_called()
        event["body"] = json.dumps({**payload(), "channel": {"channelId": "https://example.com/private"}})
        self.assertEqual(handler.lambda_handler(event, None)["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()
