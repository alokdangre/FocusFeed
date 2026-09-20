// Paste in console on YouTube search results page
(function() {
  var reelShelves = document.querySelectorAll("ytd-reel-shelf-renderer");
  console.log("=== ytd-reel-shelf-renderer ===", reelShelves.length);
  for (var i = 0; i < reelShelves.length; i++) {
    console.log("  shelf " + i, "hidden?", reelShelves[i].dataset.focusfeedHidden, "display:", reelShelves[i].style.display);
    console.log("  parent:", reelShelves[i].parentElement ? reelShelves[i].parentElement.tagName : "none");
    console.log("  grandparent:", reelShelves[i].parentElement && reelShelves[i].parentElement.parentElement ? reelShelves[i].parentElement.parentElement.tagName : "none");
  }

  var richShelves = document.querySelectorAll("ytd-rich-shelf-renderer");
  console.log("=== ytd-rich-shelf-renderer ===", richShelves.length);
  for (var j = 0; j < richShelves.length; j++) {
    var hasShorts = richShelves[j].querySelector("ytm-shorts-lockup-view-model") || richShelves[j].querySelector('a[href*="/shorts/"]');
    console.log("  shelf " + j, "hasShorts?", !!hasShorts, "hidden?", richShelves[j].dataset.focusfeedHidden, "display:", richShelves[j].style.display);
    console.log("  parent:", richShelves[j].parentElement ? richShelves[j].parentElement.tagName : "none");
    console.log("  grandparent:", richShelves[j].parentElement && richShelves[j].parentElement.parentElement ? richShelves[j].parentElement.parentElement.tagName : "none");
  }

  // Check for any section-like container with "Shorts" text
  var allShelves = document.querySelectorAll("ytd-reel-shelf-renderer, ytd-rich-shelf-renderer, ytd-shelf-renderer, ytd-item-section-renderer");
  console.log("=== ALL shelf/section elements ===");
  for (var k = 0; k < allShelves.length; k++) {
    var tag = allShelves[k].tagName;
    var titleEl = allShelves[k].querySelector("#title, .title, h2, [class*='title']");
    var titleText = titleEl ? (titleEl.innerText || "").substring(0, 40) : "(no title)";
    var shorts = allShelves[k].querySelector('a[href*="/shorts/"], ytm-shorts-lockup-view-model');
    console.log("  " + tag, "| title:", titleText, "| hasShorts:", !!shorts, "| hidden:", allShelves[k].dataset.focusfeedHidden || "no");
  }
})();
