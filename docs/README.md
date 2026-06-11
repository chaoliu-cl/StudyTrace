# StudyTrace Web Pages

This `docs/` folder contains the three public pages typically needed for TestFlight and App Store submission:

- `marketing/`
- `privacy/`
- `support/`

## Published URLs

If you publish this repo with GitHub Pages from the `docs/` folder, the pages will be available at:

- `https://chaoliu-cl.github.io/StudyTrace/marketing/`
- `https://chaoliu-cl.github.io/StudyTrace/privacy/`
- `https://chaoliu-cl.github.io/StudyTrace/support/`

Because the site uses relative links, the same files also work if you later copy them into a subpath on `liu-chao.site`, for example:

- `https://liu-chao.site/StudyTrace/marketing/`
- `https://liu-chao.site/StudyTrace/privacy/`
- `https://liu-chao.site/StudyTrace/support/`

## GitHub Pages Setup For This Repo

This repository is already configured for GitHub Pages deployment through GitHub Actions with:

- [deploy-pages.yml](/Users/chaoliu/Downloads/StudyTrace/.github/workflows/deploy-pages.yml)

The workflow deploys automatically when either of these change on the `main` branch:

- `docs/**`
- `.github/workflows/deploy-pages.yml`

### One-time repository settings

1. Push this repo to GitHub.
2. Open `https://github.com/chaoliu-cl/StudyTrace/settings/pages`
3. Under `Build and deployment`, set:
   - `Source`: `GitHub Actions`
4. Save the setting.

### Publish flow

1. Commit your site changes.
2. Push to `main`.
3. Open the `Actions` tab in the GitHub repo.
4. Wait for the `Deploy GitHub Pages` workflow to finish successfully.
5. GitHub Pages will publish the contents of `docs/`.

### Resulting Pages URLs

After the first successful deployment, the site should be available at:

- `https://chaoliu-cl.github.io/StudyTrace/`
- `https://chaoliu-cl.github.io/StudyTrace/marketing/`
- `https://chaoliu-cl.github.io/StudyTrace/privacy/`
- `https://chaoliu-cl.github.io/StudyTrace/support/`

## App Store Connect URLs

Recommended values:

- Marketing URL: the `marketing/` page
- Privacy Policy URL: the `privacy/` page
- Support URL: the `support/` page

## Personal Domain Options

### Option 1: Keep the app site in this repo

Use the included GitHub Actions workflow and publish directly from this repository.

### Option 2: Serve under `liu-chao.site`

Copy the contents of `docs/` into the appropriate subdirectory of your personal site and publish there.

This option is safer if `liu-chao.site` already hosts other content and you do not want this app repo to take over the root domain.

## Custom Domain Later

If you later want GitHub Pages itself to serve a custom domain:

1. Add your chosen hostname in the GitHub Pages settings for this repo.
2. Update DNS for that hostname to point to GitHub Pages.
3. Add a `CNAME` file in `docs/` only after you decide the exact hostname.

Do not add `docs/CNAME` yet unless you want this repo to claim a specific custom hostname immediately.
