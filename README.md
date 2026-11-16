# Publish the L.L. Thurstone anniversary website

Use the **upload-ready ZIP**, unzip it first, and start with its `website` folder. The package is configured for online submissions, but you still need to supply the account connections below. No accounts have been registered and nothing has been deployed for you.

You need your own **GitHub account** and **Cloudflare account**. Guests do not need accounts. This guide uses browser dashboards; you do not need to install development tools.

## 1. Put the website on GitHub

1. Sign in to GitHub. Create a new **public** repository named `thurstone-75` and enable **Add README**. The public repository is for website code only.
2. Inside it, choose **Add file → Upload files**. Upload the **contents of the package's `website` folder**, including `assets/` and `worker/`. Commit the upload to `main`.
3. Check that `index.html` and `config.js` are at the top level of the repository. Do not upload the ZIP file itself or put everything inside another `website/` folder.
4. Make sure an empty file named `.nojekyll` is also at the top level. It is included in the package but may be hidden in Finder. If it was skipped, use **Add file → Create new file**, enter `.nojekyll`, and commit it.
5. Open **Settings → Pages**. Choose **Deploy from a branch**, branch **main**, folder **/ (root)**, and save.
6. Wait for the Pages deployment to finish. Your website address will look like `https://YOUR-USERNAME.github.io/thurstone-75/`.

Your repository should look like:

```text
index.html            Home Page
rsvp.html             RSVP
guests.html           Who's coming
schedule.html         Schedule
hotels.html           Hotels
venue.html            Venue & Parking
photos.html           Photos, the last tab
config.js             editable event and connection settings
app.js
styles.css
assets/
worker/               service code; contains NO secrets
.nojekyll
README.md
```

The information pages can load now. Until you complete the connection steps, the forms report that submissions are not connected. [GitHub's Pages instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).

## 2. Create the PRIVATE data repository

Create a second GitHub repository named **thurstone-anniversary-data**. Choose **Private**, and enable **Add README** so its `main` branch exists. Do not turn on Pages for this repository.

This second repository will hold emails, RSVP details, special requests, and photo files. The Worker creates the data files automatically. Only organizers should have access to this repository.

## 3. Give the Worker permission to save to GitHub

In GitHub, open your account **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.

Set:

| Setting | Value |
| --- | --- |
| Token name | Thurstone anniversary submissions |
| Resource owner | The account/organization owning the private data repository |
| Repository access | Only select repositories: **thurstone-anniversary-data** |
| Repository permissions | **Contents: Read and write** |
| Expiration | A date permitted by your organization; renew before it expires |

An organization may need to approve the token. The token will go into Cloudflare as a secret in step 5. **Do not paste it into the website, `config.js`, or any GitHub file.** [GitHub file-write permissions](https://docs.github.com/en/rest/repos/contents).

## 4. Add spam protection with Turnstile

In the Cloudflare dashboard, open **Turnstile** and add a widget. Choose the managed widget type and add your website hostname, such as **YOUR-USERNAME.github.io**. Enter the hostname only, without `https://` or `/thurstone-75/`.

Cloudflare gives you two different values:

- **Site key:** public; it goes in the website's `config.js` in step 6.
- **Secret key:** private; it goes in the Worker as `TURNSTILE_SECRET` in step 5.

Use Turnstile Free. A custom domain is not needed. [Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/).

## 5. Connect and deploy the Cloudflare Worker

First, edit **`worker/wrangler.toml` in your public website repository** using GitHub's pencil button. Replace the example values under `[vars]`:

```toml
SITE_ORIGIN = "https://YOUR-USERNAME.github.io"
GITHUB_OWNER = "YOUR-USERNAME"
GITHUB_REPO = "thurstone-anniversary-data"
GITHUB_BRANCH = "main"
SUBMISSIONS_OPEN = "true"
```

`SITE_ORIGIN` must omit the repository path and trailing slash. `GITHUB_OWNER` is the owner of the **private data repository**, which may be your lab organization. Leave `name`, `main`, and the compatibility settings as supplied. Commit your edits.

Then, in Cloudflare:

1. Go to **Workers & Pages → Create application → GitHub/import repository**.
2. Connect GitHub and select your **public website repository**, `thurstone-75`. Cloudflare needs this repository to deploy the code; the separate fine-grained token handles private data writes.
3. Configure the project with these values:

| Setting | Value |
| --- | --- |
| Worker/project name | `thurstone-anniversary-submissions` |
| Production branch | `main` |
| Root directory | `worker` |
| Build command | Leave empty; there is no build step |
| Deploy command | `npx wrangler deploy` |

4. Choose **Save and Deploy**. The Worker name must match `name` in `wrangler.toml`. If offered a plan choice, start with Workers Free.
5. After deployment, open the Worker → **Settings → Variables and Secrets → Add**. Add these as **Secret** values, not plain text and not build-only variables:

| Secret name | Value |
| --- | --- |
| `GITHUB_TOKEN` | The GitHub token from step 3 |
| `TURNSTILE_SECRET` | The Turnstile secret key from step 4 |

6. Deploy/save those secret changes. Copy the production `workers.dev` address, for example `https://thurstone-anniversary-submissions.YOUR-SUBDOMAIN.workers.dev`.
7. Open that address with **`/guests`** appended. An empty guest list appears as `[]`. The root address alone returns “Not found,” which is expected.

The first deployment refuses submissions until its secrets are configured. For later configuration changes, edit `worker/wrangler.toml` in GitHub; connected builds redeploy those settings. Keep secrets in Cloudflare.

References: [Cloudflare GitHub connection](https://developers.cloudflare.com/workers/ci-cd/builds/), [build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 6. Connect the website to the Worker

In your public website repository, edit **`config.js`**. Fill in these values and commit:

```js
contactEmail: 'your-organizer-email@example.com',
dataMode: 'github',
apiUrl: 'https://thurstone-anniversary-submissions.YOUR-SUBDOMAIN.workers.dev',
turnstileSiteKey: 'YOUR-PUBLIC-TURNSTILE-SITE-KEY'
```

The upload-ready package already sets `dataMode` to `github`. Use the Worker address without `/guests`, any other path, or a trailing slash. The Turnstile **site key** belongs here; neither secret belongs here.

After GitHub Pages finishes deploying, refresh the website. Guests can now submit through the anniversary website, while the Worker saves the data privately in GitHub.

## 7. Check it before sending invitations

- Submit a test RSVP with an email and private food/accessibility notes. Confirm the full record exists in the private repository's `data/rsvps.json`.
- Open the public guest list in a second browser. Only the name, connection, lab years, and +1 status should appear. The list may take up to 30 seconds to refresh.
- Check that an opted-out or declined RSVP stays off the public list. A duplicate email should request organizer help rather than overwrite a response.
- Upload a test photo. It should be saved privately and appear publicly only after approval. In `data/photos.json`, review the matching image, then change its `approved` field from `false` to `true` and commit.
- Test a phone photo and check Cloudflare for errors. The Worker is tested locally with simulated services; its live account connection and free-plan processing limits must be checked after deployment.

For guest corrections, email collection, photo removal, data retention, and closing submissions, see **`worker/SETUP.md`** in the package.

## If something does not work

| Symptom | Check |
| --- | --- |
| Website shows 404 | `index.html` must be at the public repository root; Pages must use `main` and `/ (root)` |
| Worker cannot find its entry file | Cloudflare root directory must be `worker`; that folder must contain `worker.mjs` and `wrangler.toml` |
| Worker name mismatch | Use `thurstone-anniversary-submissions` in Cloudflare and in `wrangler.toml` |
| Forms say they are not connected | Fill `apiUrl` and `turnstileSiteKey` in the published `config.js` |
| Verification fails | Turnstile hostname must match the website; use the matching site/secret keys |
| Connection works from one URL only | `SITE_ORIGIN` must exactly match the website's origin, including `https://`, without a path |
| `/guests` reports a storage problem | Private repository must exist with its branch initialized; token must have access, approval if required, and Contents read/write permission |
| A photo is missing from the public gallery | Pending photos require organizer approval; list/image caching can delay changes briefly |

No account registration, payment, or deployment has been performed for you. The package is ready to upload and configure.
