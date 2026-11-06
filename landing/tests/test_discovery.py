"""Check published product facts and crawler discovery without third-party packages.

Run after `node build-site.mjs` using:
    python -m unittest discover -s landing/tests
Set OWNFEED_SITE_DIR to check the final Cloudflare static output as well.
"""

import json
import os
from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET


SOURCE = Path(__file__).resolve().parents[1]
SITE = Path(os.environ.get("OWNFEED_SITE_DIR", SOURCE))
ORIGIN = "https://ownfeed.tech"
PAGES = {"index.html": "/", "privacy.html": "/privacy", "terms.html": "/terms"}


def normalized(value):
    return " ".join(value.split())


class Page(HTMLParser):
    def __init__(self, filename):
        super().__init__()
        self.metadata = {}
        self.canonicals = []
        self.ids = []
        self.faq = {}
        self.schemas = []
        self._detail = None
        self._summary = False
        self._answer = False
        self._json = None
        self.feed((SITE / filename).read_text())

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "meta":
            self.metadata[attrs.get("name", attrs.get("property"))] = attrs.get("content")
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonicals.append(attrs["href"])
        if tag == "script" and attrs.get("type") == "application/ld+json":
            self._json = []
        if tag == "details" and "id" in attrs:
            self._detail = {"question": [], "answer": []}
            self.faq[attrs["id"]] = self._detail
        if self._detail:
            if tag == "summary":
                self._summary = True
            if "faq-answer" in attrs.get("class", "").split():
                self._answer = True

    def handle_data(self, data):
        if self._json is not None:
            self._json.append(data)
        if self._detail:
            if self._summary:
                self._detail["question"].append(data)
            if self._answer:
                self._detail["answer"].append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._json is not None:
            self.schemas.append(json.loads("".join(self._json)))
            self._json = None
        if tag == "summary":
            self._summary = False
        if tag == "div":
            self._answer = False
        if tag == "details":
            self._detail = None


class DiscoveryTests(unittest.TestCase):
    def test_canonicals_and_page_metadata(self):
        for filename, path in PAGES.items():
            with self.subTest(filename=filename):
                page = Page(filename)
                self.assertEqual(page.canonicals, [ORIGIN + path])
                self.assertEqual(page.metadata["og:url"], ORIGIN + path)
                self.assertTrue(page.metadata["description"])
                self.assertIn("index", page.metadata["robots"].split(", "))
                self.assertEqual(page.metadata["twitter:card"], "summary_large_image")
                image = urlsplit(page.metadata["og:image"])
                self.assertEqual(image.netloc, "ownfeed.tech")
                self.assertTrue((SITE / image.path.lstrip("/")).is_file())
                self.assertEqual(len(page.ids), len(set(page.ids)))
                for schema in page.schemas:
                    self.assertEqual(schema["@context"], "https://schema.org")

    def test_structured_answers_match_readable_html(self):
        page = Page("index.html")
        graph = page.schemas[0]["@graph"]
        webpage = next(item for item in graph if "FAQPage" in item["@type"])
        actual = {
            normalized("".join(item["question"])): normalized("".join(item["answer"]))
            for item in page.faq.values()
        }
        expected = {
            item["name"]: normalized(item["acceptedAnswer"]["text"])
            for item in webpage["mainEntity"]
        }
        self.assertGreaterEqual(len(actual), 7)
        self.assertEqual(actual, expected)
        self.assertIn("installation", page.ids)
        app = next(item for item in graph if item["@type"] == "SoftwareApplication")
        self.assertEqual(app["creativeWorkStatus"], "Developer preview")
        self.assertNotIn("offers", app)  # Planned Pro pricing is not a purchasable offer.
        self.assertNotIn("aggregateRating", app)
        self.assertNotIn("downloadUrl", app)
        self.assertNotIn("installUrl", app)

    def test_no_extension_archives_are_published(self):
        self.assertEqual(list((SITE / "assets").rglob("*.zip")), [])
        for filename in ["index.html", "about.md", "llms.txt"]:
            self.assertNotIn(".zip", (SITE / filename).read_text())

    def test_sitemap_contains_only_canonical_pages(self):
        root = ET.parse(SITE / "sitemap.xml").getroot()
        urls = [item.text for item in root.findall("{*}url/{*}loc")]
        self.assertCountEqual(urls, [ORIGIN + path for path in PAGES.values()])
        for filename in PAGES:
            self.assertIn(Page(filename).canonicals[0], urls)

    def test_search_and_ai_crawlers_can_read_content_and_assets(self):
        policy = (SITE / "robots.txt").read_text()
        robots = RobotFileParser()
        robots.parse(policy.splitlines())
        self.assertEqual(robots.site_maps(), [ORIGIN + "/sitemap.xml"])
        for agent in ["Googlebot", "Bingbot", "OAI-SearchBot", "ChatGPT-User",
                      "Claude-SearchBot", "Claude-User", "PerplexityBot"]:
            for path in [*PAGES.values(), "/llms.txt", "/about.md", "/styles.css",
                         "/assets/cloudbreak.webp"]:
                with self.subTest(agent=agent, path=path):
                    self.assertTrue(robots.can_fetch(agent, ORIGIN + path))

    def test_build_preserves_discovery_files_and_mime_rules(self):
        for filename in ["robots.txt", "sitemap.xml", "llms.txt", "about.md", "_headers"]:
            with self.subTest(filename=filename):
                self.assertEqual((SOURCE / ".site-public" / filename).read_bytes(),
                                 (SOURCE / filename).read_bytes())
                self.assertEqual((SITE / filename).read_bytes(), (SOURCE / filename).read_bytes())
        headers = (SITE / "_headers").read_text()
        self.assertIn("/about.md\n  Content-Type: text/markdown; charset=utf-8", headers)
        self.assertIn("/sitemap.xml\n  Content-Type: application/xml; charset=utf-8", headers)


if __name__ == "__main__":
    unittest.main()
