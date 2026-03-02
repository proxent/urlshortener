const urlInput = document.getElementById("urlInput");
const createBtn = document.getElementById("createBtn");
const result = document.getElementById("result");

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

function renderCreatedUrl(shortUrl) {
  result.replaceChildren();
  result.append(document.createTextNode("Short URL created:"), document.createElement("br"));
  result.appendChild(createSafeLink(shortUrl, shortUrl));
}

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
  } catch (err) {
    result.textContent = err.message;
  }
});
