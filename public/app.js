const urlInput = document.getElementById("urlInput");
const createBtn = document.getElementById("createBtn");
const refreshBtn = document.getElementById("refreshBtn");
const result = document.getElementById("result");
const linksList = document.getElementById("links");

function toSafeHttpUrl(value) {
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch (_) {
    // Fall through and return null for invalid URLs.
  }
  return null;
}

function createSafeLink(url, text) {
  const a = document.createElement("a");
  const safeUrl = toSafeHttpUrl(url);
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  if (safeUrl) {
    a.href = safeUrl;
  } else {
    a.removeAttribute("target");
  }

  return a;
}

// Create short URL
async function createShortUrl(url) {
  const res = await fetch("/shorten", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "An error occurred");

  return data;
}

// Fetch links
async function fetchLinks() {
  const res = await fetch("/links");
  return res.json();
}

// Render links
function renderLinks(links) {
  linksList.innerHTML = "";

  if (links.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No links have been created yet.";
    linksList.appendChild(li);
    return;
  }

  links.forEach((link) => {
    const li = document.createElement("li");
    const shortLink = createSafeLink(link.shortUrl, link.shortUrl);
    const arrow = document.createTextNode(" \u2192 ");
    const originalUrl = document.createTextNode(link.originalUrl);
    const meta = document.createElement("div");

    meta.className = "meta";
    meta.textContent = `Clicks: ${link.hitCount}`;

    li.appendChild(shortLink);
    li.appendChild(arrow);
    li.appendChild(originalUrl);
    li.appendChild(meta);

    linksList.appendChild(li);
  });
}

function renderCreatedUrl(shortUrl) {
  result.replaceChildren();
  result.append(document.createTextNode("Short URL created:"), document.createElement("br"));
  result.appendChild(createSafeLink(shortUrl, shortUrl));
}

// Create short URL button click
createBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    result.textContent = "Please enter a URL.";
    return;
  }

  result.textContent = "Creating...";

  try {
    const data = await createShortUrl(url);
    renderCreatedUrl(data.shortUrl);

    urlInput.value = "";

    // Refresh list
    const links = await fetchLinks();
    renderLinks(links);
  } catch (err) {
    result.textContent = err.message;
  }
});

// Refresh button
refreshBtn.addEventListener("click", async () => {
  const links = await fetchLinks();
  renderLinks(links);
});

// Auto-load list on page load
(async () => {
  const links = await fetchLinks();
  renderLinks(links);
})();
