const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
require('dotenv').config();

// Load WABA guide once at startup
const WABA_GUIDE = fs.readFileSync(path.join(__dirname, 'waba_guide.md'), 'utf8');

// Groq client (lazy — only used if GROQ_API_KEY is set)
function getGroqClient() {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') throw new Error('GROQ_API_KEY not set in .env');
  return new Groq({ apiKey: key });
}

let browser;

async function getBrowser() {
  if (!browser) {
    try {
      browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
    } catch (err) {
      console.error('Failed to launch browser:', err);
    }
  }
  return browser;
}

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// Keywords to detect pages
const PAGE_KEYWORDS = {
  terms: [
    'terms', 'terms and conditions', 'terms of service', 'terms of use',
    'tos', 'terms & conditions', 'legal'
  ],
  privacy: [
    'privacy', 'privacy policy', 'data policy', 'data protection',
    'cookie policy', 'privacy notice'
  ],
  about: [
    'about', 'about us', 'our story', 'who we are', 'company', 'mission'
  ],
  contact: [
    'contact', 'contact us', 'get in touch', 'reach us', 'support', 'help'
  ],
  home: [
    'home', 'index', 'main', 'start', 'welcome', '/'
  ]
};

function normalizeUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url.trim();
}

// ─── Input Validation ────────────────────────────────────────────────────────
function validateInputs({ url, email, displayName, legalName, phone }) {
  const errors = {};

  // URL: required + must be a valid URL after normalization
  if (!url || !url.trim()) {
    errors.url = 'URL is required.';
  } else {
    const normalized = normalizeUrl(url.trim());
    try {
      new URL(normalized);
    } catch {
      errors.url = 'Invalid URL format. Example: https://example.com';
    }
  }

  // Email: optional but must be valid if provided
  if (email && email.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      errors.email = 'Invalid email format. Example: contact@example.com';
    }
  }

  // Display Name: optional, but validated if provided
  if (displayName && displayName.trim()) {
    const dn = displayName.trim();
    const genericTerms = ['and', 'or', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are', 'am'];

    if (dn.length < 3) {
      errors.displayName = 'Display name must be at least 3 characters long.';
    } else if (dn.length > 60) {
      errors.displayName = 'Display name must be 60 characters or fewer.';
    } else if (/^https?:\/\//i.test(dn) || /\.(com|net|org|io|co)\b/i.test(dn)) {
      errors.displayName = 'Display name cannot be a URL or web address.';
    } else if (/whatsapp/i.test(dn)) {
      errors.displayName = 'Display name cannot contain the word "WhatsApp" (Meta policy).';
    } else if (dn === dn.toUpperCase() && /[A-Z]{2,}/.test(dn)) {
      errors.displayName = 'Display name cannot be ALL CAPS (Meta policy requires standard capitalization).';
    } else if (genericTerms.includes(dn.toLowerCase())) {
      errors.displayName = `Meta Policy Violation: "${dn}" is a generic term. Display names must represent your business faithfully and cannot consist entirely of generic words (e.g., "Shoes", "and") or just geographic locations.`;
    }
  }

  // Legal Name: optional, but validated if provided
  if (legalName && legalName.trim()) {
    const ln = legalName.trim();
    if (ln.length < 2) {
      errors.legalName = 'Legal name must be at least 2 characters long.';
    } else if (ln.length > 100) {
      errors.legalName = 'Legal name must be 100 characters or fewer.';
    }
  }

  // Phone Number: optional, but validated if provided
  if (phone && phone.trim()) {
    const p = phone.replace(/[^0-9+]/g, '');
    if (p.length < 10) {
      errors.phone = 'Phone number is too short. Ensure it includes the country code.';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

function extractBaseUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

function extractRootDomain(urlOrHost) {
  if (!urlOrHost) return '';
  try {
    let host = urlOrHost;
    if (urlOrHost.includes('://')) {
      host = new URL(urlOrHost).hostname;
    } else {
      // If no protocol, it might be just "google.com" or "google.com/path"
      host = urlOrHost.split('/')[0];
    }
    const parts = host.split('.').reverse();
    if (parts.length >= 2) {
      return `${parts[1]}.${parts[0]}`.toLowerCase();
    }
    return host.toLowerCase();
  } catch {
    return urlOrHost.toLowerCase();
  }
}

function checkDomainMatch(siteUrl, email) {
  if (!email || !email.includes('@')) return { match: false, error: 'Invalid email' };
  const siteDomain = extractRootDomain(siteUrl);
  const emailDomain = extractRootDomain(email.split('@')[1]);
  return {
    match: siteDomain === emailDomain,
    siteDomain,
    emailDomain
  };
}

function checkDisplayName($, displayName) {
  if (!displayName) return { match: false, error: 'No display name provided' };
  const dn = displayName.toLowerCase().trim();

  // Only check header and footer text
  const headerText = $('header').text().toLowerCase();
  const footerText = $('footer').text().toLowerCase();

  const inHeader = headerText.includes(dn);
  const inFooter = footerText.includes(dn);

  // Strict Check (apply same logic as Legal name)
  const commonSuffixes = ['inc', 'ltd', 'llc', 'limited', 'corp', 'corporation'];
  const hasSuffixMatch = (txt, target) => {
    const index = txt.indexOf(target);
    if (index === -1) return false;
    const after = txt.substring(index + target.length).trim().toLowerCase();
    return commonSuffixes.some(sfx => after.startsWith(sfx) || after.startsWith(sfx + '.'));
  };

  let strictMatch = (inHeader || inFooter);
  if (strictMatch) {
    const userHasSuffix = commonSuffixes.some(sfx => dn.includes(' ' + sfx));
    if (!userHasSuffix) {
      const siteHasExtraSuffix = hasSuffixMatch(headerText, dn) || hasSuffixMatch(footerText, dn);
      if (siteHasExtraSuffix) {
        strictMatch = false;
      }
    }
  }

  return {
    match: strictMatch,
    details: {
      inHeader,
      inFooter,
      strictMatch
    }
  };
}

function checkLegalName($, legalName) {
  if (!legalName) return { match: false, error: 'No legal name provided' };
  const ln = legalName.toLowerCase().trim();
  const bodyText = $('body').text().toLowerCase();
  const footerText = $('footer').text().toLowerCase();

  // 1. Look for legal name near copyright symbols or "Copyright" text
  const copyrightIndex = bodyText.indexOf('©') !== -1 ? bodyText.indexOf('©') : bodyText.indexOf('copyright');

  let proximityMatch = false;
  let snippet = '';

  if (copyrightIndex !== -1) {
    const start = Math.max(0, copyrightIndex - 50);
    const end = Math.min(bodyText.length, copyrightIndex + 150);
    snippet = bodyText.substring(start, end).replace(/\s+/g, ' ');
    if (snippet.includes(ln)) {
      proximityMatch = true;
    }
  }

  // 2. Check the entire footer for a more general match
  const inFooter = footerText.includes(ln);

  // 3. Strict Check: If match found, ensure it's not immediately followed by common suffixes 
  // that the user DID NOT provide.
  // e.g. user enters "Apple" but site has "Apple Inc.", we should NOT match.
  const commonSuffixes = ['inc', 'ltd', 'llc', 'limited', 'corp', 'corporation'];
  const hasSuffixMatch = (txt, target) => {
    const index = txt.indexOf(target);
    if (index === -1) return false;

    // Get text after the match
    const after = txt.substring(index + target.length).trim().toLowerCase();
    // Check if it starts with any common suffixes (with or without a dot)
    return commonSuffixes.some(sfx => after.startsWith(sfx) || after.startsWith(sfx + '.'));
  };

  let strictMatch = (proximityMatch || inFooter);

  if (strictMatch) {
    // If the user's input doesn't already contain a suffix, 
    // but the found text in the site does, then it's NOT an exact match.
    const userHasSuffix = commonSuffixes.some(sfx => ln.includes(' ' + sfx));
    if (!userHasSuffix) {
      const siteHasExtraSuffix = hasSuffixMatch(snippet, ln) || hasSuffixMatch(footerText, ln);
      if (siteHasExtraSuffix) {
        strictMatch = false;
      }
    }
  }

  return {
    match: strictMatch,
    details: {
      proximityMatch,
      inFooter,
      strictMatch,
      snippet: snippet.substring(0, 150)
    }
  };
}

function matchesKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

// Find links from the page that match a page type
function findMatchingLinks($, baseUrl, keywords) {
  const found = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const linkText = $(el).text().trim();
    const combined = (href + ' ' + linkText).toLowerCase();
    if (keywords.some(kw => combined.includes(kw))) {
      let fullUrl = href;
      if (href.startsWith('/')) {
        fullUrl = baseUrl + href;
      } else if (!href.startsWith('http')) {
        fullUrl = baseUrl + '/' + href;
      }
      found.push({ href: fullUrl, text: linkText });
    }
  });
  return found;
}

// Fetch a URL safely
async function fetchPage(url, timeout = 10000) {
  try {
    const resp = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      maxRedirects: 5
    });
    return { success: true, data: resp.data, finalUrl: resp.request.res?.responseUrl || url, status: resp.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Check if page content is not blank/thin
function isPageNotBlank($) {
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return bodyText.length > 200;
}

// Extract copyright name from page
function extractCopyright($) {
  const bodyText = $('body').text();
  // Common copyright patterns
  const patterns = [
    /©\s*(?:\d{4}[-–]\d{4}|\d{4})?\s*([A-Z][^\n.©,]{2,60})/i,
    /copyright\s*©?\s*(?:\d{4}[-–]\d{4}|\d{4})?\s*([A-Z][^\n.©,]{2,60})/i,
    /&copy;\s*(?:\d{4}[-–]\d{4}|\d{4})?\s*([A-Z][^\n.©,]{2,60})/i,
    /\(c\)\s*(?:\d{4}[-–]\d{4}|\d{4})?\s*([A-Z][^\n.©,]{2,60})/i
  ];

  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match && match[1]) {
      return match[1].trim().replace(/\s+/g, ' ').substring(0, 80);
    }
  }

  // Try HTML specifically (for encoded ©)
  const html = $.html();
  const htmlPatterns = [
    /&copy;\s*(?:\d{4}[-–]\d{4}|\d{4})?\s*([A-Za-z][^<&\n]{2,60})/i,
    /&#169;\s*(?:\d{4}[-–]\d{4}|\d{4})?\s*([A-Za-z][^<&\n]{2,60})/i
  ];
  for (const pattern of htmlPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1].trim().replace(/\s+/g, ' ').substring(0, 80);
    }
  }

  return null;
}

// Check a specific page type
async function checkPage(type, baseUrl, $mainPage, mainHtml) {
  const keywords = PAGE_KEYWORDS[type];

  // Special case for home: the main page IS the home
  if (type === 'home') {
    const mainResult = await fetchPage(baseUrl);
    return {
      found: mainResult.success,
      notBlank: mainResult.success ? isPageNotBlank(cheerio.load(mainResult.data)) : false,
      url: baseUrl,
      error: mainResult.error || null
    };
  }

  // Find matching links in the main page
  const matchingLinks = findMatchingLinks($mainPage, baseUrl, keywords);

  if (matchingLinks.length === 0) {
    // Try common URL patterns
    const commonPaths = {
      terms: ['/terms', '/terms-and-conditions', '/terms-of-service', '/tos', '/legal/terms'],
      privacy: ['/privacy', '/privacy-policy', '/privacy-notice', '/legal/privacy'],
      about: ['/about', '/about-us', '/company', '/who-we-are'],
      contact: ['/contact', '/contact-us', '/support', '/help', '/get-in-touch']
    };

    const paths = commonPaths[type] || [];
    for (const path of paths) {
      const testUrl = baseUrl + path;
      const result = await fetchPage(testUrl, 7000);
      if (result.success) {
        const $ = cheerio.load(result.data);
        return {
          found: true,
          notBlank: isPageNotBlank($),
          url: testUrl,
          error: null
        };
      }
    }

    return { found: false, notBlank: false, url: null, error: 'Page not found in navigation or common paths' };
  }

  // Try the first matching link
  const link = matchingLinks[0];
  const result = await fetchPage(link.href, 8000);
  if (result.success) {
    const $ = cheerio.load(result.data);
    return {
      found: true,
      notBlank: isPageNotBlank($),
      url: link.href,
      error: null
    };
  }

  return { found: false, notBlank: false, url: link.href, error: result.error };
}

app.post('/api/check', async (req, res) => {
  let { url, email, displayName, legalName, phone } = req.body;

  // Validate inputs before any network requests
  const validation = validateInputs({ url, email, displayName, legalName, phone });
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', validationErrors: validation.errors });
  }

  url = normalizeUrl(url);

  // Check HTTPS
  const isHttps = url.startsWith('https://');

  // Fetch main page
  const mainResult = await fetchPage(url);
  if (!mainResult.success) {
    return res.status(200).json({
      url,
      isHttps,
      mainPageAccessible: false,
      error: mainResult.error,
      checks: {}
    });
  }

  const baseUrl = extractBaseUrl(url);
  const $main = cheerio.load(mainResult.data);

  // Extract copyright
  const copyrightName = extractCopyright($main);

  // Run all page checks in parallel
  const [termsResult, privacyResult, aboutResult, contactResult, homeResult] = await Promise.all([
    checkPage('terms', baseUrl, $main, mainResult.data),
    checkPage('privacy', baseUrl, $main, mainResult.data),
    checkPage('about', baseUrl, $main, mainResult.data),
    checkPage('contact', baseUrl, $main, mainResult.data),
    checkPage('home', baseUrl, $main, mainResult.data)
  ]);

  // Run the new verification checks
  const verification = {
    domainEmail: checkDomainMatch(url, email),
    displayName: checkDisplayName($main, displayName),
    legalName: checkLegalName($main, legalName),
    whatsappActive: phone && phone.trim() ? {
      match: true,
      link: `https://wa.me/${phone.replace(/[^0-9]/g, '')}`
    } : null
  };

  return res.status(200).json({
    url,
    isHttps,
    mainPageAccessible: true,
    copyrightName,
    checks: {
      home: homeResult,
      termsAndConditions: termsResult,
      privacyPolicy: privacyResult,
      aboutUs: aboutResult,
      contactUs: contactResult
    },
    verification
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// NEW: /api/waba-check  — runs the same scraping as /api/check, then asks
// Groq to evaluate the results against the WABA onboarding guide.
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/waba-check', async (req, res) => {
  let { url, email, displayName, legalName, phone } = req.body;

  // Validate inputs before any network requests
  const validation = validateInputs({ url, email, displayName, legalName, phone });
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', validationErrors: validation.errors });
  }

  // ── 1. Run the same checks as /api/check ──────────────────────────────────
  url = normalizeUrl(url);
  const isHttps = url.startsWith('https://');

  const mainResult = await fetchPage(url);
  if (!mainResult.success) {
    return res.status(200).json({
      url, isHttps, mainPageAccessible: false,
      error: mainResult.error, checks: {}, groqAnalysis: null
    });
  }

  const baseUrl = extractBaseUrl(url);
  const $main = cheerio.load(mainResult.data);
  const copyrightName = extractCopyright($main);

  const [termsResult, privacyResult, aboutResult, contactResult, homeResult] = await Promise.all([
    checkPage('terms', baseUrl, $main, mainResult.data),
    checkPage('privacy', baseUrl, $main, mainResult.data),
    checkPage('about', baseUrl, $main, mainResult.data),
    checkPage('contact', baseUrl, $main, mainResult.data),
    checkPage('home', baseUrl, $main, mainResult.data)
  ]);

  const verification = {
    domainEmail: checkDomainMatch(url, email),
    displayName: checkDisplayName($main, displayName),
    legalName: checkLegalName($main, legalName),
    whatsappActive: phone && phone.trim() ? {
      match: true,
      link: `https://wa.me/${phone.replace(/[^0-9]/g, '')}`
    } : null
  };

  const checkData = {
    url, isHttps,
    mainPageAccessible: true,
    copyrightName,
    checks: {
      home: homeResult,
      termsAndConditions: termsResult,
      privacyPolicy: privacyResult,
      aboutUs: aboutResult,
      contactUs: contactResult
    },
    verification
  };

  // ── 2. Send to Groq for WABA compliance analysis ──────────────────────────
  let groqAnalysis = null;
  try {
    const groq = getGroqClient();

    const prompt = `You are a Meta WhatsApp Business API (WABA) onboarding compliance expert.

Below is the WABA Onboarding & Compliance Guide:
───────────────────────────────────────────────
${WABA_GUIDE}
───────────────────────────────────────────────

Below is the automated website scan result for the business website:
${JSON.stringify(checkData, null, 2)}

Additional user-provided info:
- Display Name: ${displayName || 'Not provided'}
- Legal Name: ${legalName || 'Not provided'}
- Contact Email: ${email || 'Not provided'}
- Phone Number: ${phone || 'Not provided'}

Based on the guide and the scan results, provide a structured WABA compliance report with:
1. ✅ PASSED checks (with brief explanation)
2. ❌ FAILED checks (with clear reason)
3. ⚠️ WARNINGS / items that need manual verification
4. 📋 OVERALL VERDICT: Ready for WABA Submission | Needs Fixes Before Submission
5. 🔧 Next Steps: A short prioritized action list

Be concise, factual, and actionable.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2048
    });

    groqAnalysis = completion.choices[0]?.message?.content || null;
  } catch (err) {
    groqAnalysis = `Groq analysis unavailable: ${err.message}`;
  }

  return res.status(200).json({ ...checkData, groqAnalysis });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0-AXIOS' });
});

app.listen(PORT, () => {
  console.log(`Server v2.0-AXIOS running on http://localhost:${PORT}`);
});
