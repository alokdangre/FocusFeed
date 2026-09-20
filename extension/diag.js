// Paste this entire block into DevTools console on YouTube
(function() {
  var el = document.querySelector("yt-lockup-view-model");
  if (!el) { console.log("yt-lockup-view-model NOT FOUND"); return; }
  console.log("=== TAG ===", el.tagName);
  console.log("=== INNER HTML (2000 chars) ===");
  console.log(el.innerHTML.substring(0, 2000));
  var t1 = el.querySelector("#video-title");
  var t2 = el.querySelector("h3");
  var t3 = el.querySelector("[title]");
  var t4 = el.querySelector("a");
  var t5 = el.querySelector("yt-formatted-string");
  console.log("=== TITLE ATTEMPTS ===");
  console.log("  #video-title innerText:", t1 ? t1.innerText : "NOT FOUND");
  console.log("  h3 innerText:", t2 ? t2.innerText : "NOT FOUND");
  console.log("  [title] attr:", t3 ? t3.getAttribute("title") : "NOT FOUND");
  console.log("  first <a> aria-label:", t4 ? t4.getAttribute("aria-label") : "NOT FOUND");
  console.log("  yt-formatted-string:", t5 ? t5.innerText : "NOT FOUND");
  var c1 = el.querySelector('a[href*="/@"]');
  var c2 = el.querySelector("ytd-channel-name");
  var c3 = el.querySelector("[id*=channel]");
  console.log("=== CHANNEL ATTEMPTS ===");
  console.log("  a[href*=/@]:", c1 ? c1.innerText : "NOT FOUND");
  console.log("  ytd-channel-name:", c2 ? c2.innerText : "NOT FOUND");
  console.log("  [id*=channel]:", c3 ? c3.innerText : "NOT FOUND");
  console.log("=== SHORTS CHECK ===");
  console.log("  has /shorts/ link:", !!el.querySelector('a[href*="/shorts/"]'));
  console.log("  has overlay-style SHORTS:", !!el.querySelector('[overlay-style="SHORTS"]'));
  console.log("=== ALL LINKS ===");
  var links = el.querySelectorAll("a");
  for (var i = 0; i < links.length; i++) {
    console.log("  link " + i + ":", links[i].getAttribute("href"), "| text:", links[i].innerText.substring(0, 50));
  }
})();
