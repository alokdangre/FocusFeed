// Paste this entire block into DevTools console on YouTube SEARCH RESULTS page
(function() {
  // Check for any /shorts/ links on the page
  var shorts = document.querySelectorAll('a[href*="/shorts/"]');
  console.log("=== SHORTS LINKS FOUND ===", shorts.length);
  for (var i = 0; i < Math.min(shorts.length, 3); i++) {
    var p = shorts[i];
    var parents = [];
    for (var d = 0; d < 8; d++) {
      p = p.parentElement;
      if (!p) break;
      parents.push(p.tagName.toLowerCase());
    }
    console.log("link " + i, "href:", shorts[i].getAttribute("href"), "| parent chain:", parents.join(" > "));
  }

  // Check yt-lockup-view-model elements that contain /shorts/ links
  var lockups = document.querySelectorAll("yt-lockup-view-model");
  var shortsLockups = 0;
  for (var j = 0; j < lockups.length; j++) {
    if (lockups[j].querySelector('a[href*="/shorts/"]')) {
      shortsLockups++;
      if (shortsLockups <= 2) {
        console.log("=== SHORTS LOCKUP " + shortsLockups + " ===");
        console.log("  hidden?", lockups[j].dataset.focusfeedHidden);
        console.log("  display:", lockups[j].style.display);
        console.log("  closest ytd-rich-item:", !!lockups[j].closest("ytd-rich-item-renderer"));
        console.log("  parent tag:", lockups[j].parentElement ? lockups[j].parentElement.tagName : "none");
      }
    }
  }
  console.log("Total yt-lockup-view-model with /shorts/ links:", shortsLockups);

  // Check if Shorts are in a different container entirely
  var reelShelves = document.querySelectorAll("ytd-reel-shelf-renderer");
  console.log("=== ytd-reel-shelf-renderer count ===", reelShelves.length);

  // Check for any element with "shorts" in tag name
  var allElements = document.querySelectorAll("*");
  var shortsTags = {};
  for (var k = 0; k < allElements.length; k++) {
    var tag = allElements[k].tagName.toLowerCase();
    if (tag.includes("short") || tag.includes("reel")) {
      if (!shortsTags[tag]) shortsTags[tag] = 0;
      shortsTags[tag]++;
    }
  }
  console.log("=== Elements with 'short' or 'reel' in tag name ===", shortsTags);
})();
