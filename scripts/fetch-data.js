#!/usr/bin/env node
// Fetches all GitHub data and writes to data/github.json
// Runs in GitHub Actions with GITHUB_TOKEN (5,000 req/hr)

const fs = require('fs');
const https = require('https');
const path = require('path');

const USERNAME = 'randomdrake';
const TOKEN = process.env.GITHUB_TOKEN;

function apiFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: urlPath,
      headers: {
        'User-Agent': 'randomdrake-dashboard',
        'Accept': 'application/vnd.github+json',
      },
    };
    if (TOKEN) {
      opts.headers['Authorization'] = `Bearer ${TOKEN}`;
    }
    https.get(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          console.error(`API ${res.statusCode}: ${urlPath}`);
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

async function fetchAllPages(basePath, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const data = await apiFetch(`${basePath}${sep}per_page=100&page=${page}`);
    if (!data || data.length === 0) break;
    all.push(...data);
  }
  return all;
}

async function main() {
  console.log('Fetching profile...');
  const profile = await apiFetch(`/users/${USERNAME}`);
  if (!profile) {
    console.error('Failed to fetch profile, aborting');
    process.exit(1);
  }

  console.log('Fetching repos...');
  const rawRepos = await fetchAllPages(`/users/${USERNAME}/repos`);
  const repos = rawRepos.map(r => ({
    name: r.name,
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description,
    fork: r.fork,
    language: r.language,
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  }));

  console.log(`Found ${repos.length} repos`);

  // Languages for each repo
  console.log('Fetching languages...');
  const languages = {};
  for (const repo of repos) {
    const langs = await apiFetch(`/repos/${USERNAME}/${repo.name}/languages`);
    if (langs) languages[repo.name] = langs;
  }

  // Assemble output (the page consumes profile, repos, languages, and stats)
  const output = {
    generated_at: new Date().toISOString(),
    profile: {
      name: profile.name,
      bio: profile.bio,
      location: profile.location,
      blog: profile.blog,
      avatar_url: profile.avatar_url,
      public_repos: profile.public_repos,
      followers: profile.followers,
    },
    repos,
    languages,
  };

  // Compute aggregates
  let totalCodeBytes = 0;
  Object.values(languages).forEach(langs => {
    Object.values(langs).forEach(bytes => { totalCodeBytes += bytes; });
  });

  output.stats = {
    total_stars: repos.reduce((s, r) => s + r.stargazers_count, 0),
    total_forks: repos.reduce((s, r) => s + r.forks_count, 0),
    total_code_bytes: totalCodeBytes,
  };

  const outPath = path.join(__dirname, '..', 'data', 'github.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`Written to ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
  console.log(`Stats: ${repos.length} repos, ${output.stats.total_stars} stars`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
