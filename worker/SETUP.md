# Connect Cloudflare Workers and GitHub

The website and all durable submissions stay on GitHub. Cloudflare runs the small program that receives forms and safely reads/writes the private data repository. Guests do not need accounts.

**Prepared locally, not deployed:** `worker.mjs` contains the service, `wrangler.toml` contains example configuration, and `worker.test.mjs` contains offline tests. No Cloudflare account, repository, token, or paid service has been created by this project.

## What you will have

| Part | Where it lives |
| --- | --- |
| Public website | Your website repository, served by GitHub Pages |
| Private RSVP details and uploaded photos | A separate private GitHub repository |
| Submission service | Cloudflare Worker, using its included `workers.dev` address |
| Spam protection | Cloudflare Turnstile |

You do not need to buy a domain. Start with Workers Free and Turnstile Free. As checked November 15, 2026, Workers Free includes 100,000 requests/day and 10 ms CPU time per invocation. The optional paid plan starts at $5/month. Traffic allowance should be ample for this event, but test real photo uploads against the processing limit before invitations. The browser does image resizing, reducing Worker processing. GitHub API/storage limits still apply separately.

## 1. Publish the website files

Create or use your website repository. Upload the seven HTML files, `app.js`, `config.js`, `styles.css`, `.nojekyll`, and `assets/`. Enable **Settings → Pages → Deploy from a branch**, using the appropriate branch and root folder.

Record its URL, for example `https://YOUR-USERNAME.github.io/thurstone-75/`. The upload-ready package uses `dataMode: 'github'`; the source project keeps `local` mode for preview. Neither accepts live submissions until connected. For a dashboard walkthrough using the prepared package, follow the [publishing guide](../README.md).

The source files in `backend/` may be kept in the website repository because they contain no secrets. Never put the private data files there.

## 2. Create a PRIVATE data repository

In GitHub, create another repository, for example **thurstone-anniversary-data**:

- Choose **Private**.
- Initialize it with a README so its `main` branch exists.
- Do not enable Pages for this repository.
- Limit collaborator access to organizers who should see private responses.

The Worker creates these files as submissions arrive:

```text
data/rsvps.json       private responses, including emails and special requests
data/photos.json      photo details and approval status
photos/<id>.webp      or .jpg; uploaded image files
```

The Worker checks that the repository is private before accessing uncached data or accepting submissions. It refuses to write to a public repository.

## 3. Create the GitHub write token

In GitHub settings, open **Developer settings → Personal access tokens → Fine-grained tokens** and generate a token:

- Resource owner: the account or organization that owns the private data repository.
- Repository access: **Only select repositories**, selecting only the private data repository.
- Repository permissions: **Contents — Read and write**. Metadata read permission is automatic.
- Choose an expiration allowed by your organization and plan to renew it if it expires before the event.

An organization may need to approve the token. Copy it directly into the Worker secret in step 5. Do not put it in the website files, a commit, a screenshot, or this guide.

## 4. Create a Turnstile widget

In the Cloudflare dashboard, open **Turnstile**, add a widget, and choose the managed widget type. Add your website hostname, such as **YOUR-USERNAME.github.io**, without `https://` or a repository path. If you use a custom website domain, use that hostname instead.

Keep both values:

- **Site key:** public; goes in `config.js`.
- **Secret key:** private; goes in the Worker as `TURNSTILE_SECRET`.

The service validates the token, website hostname, and form action on every submission. There is no production CAPTCHA bypass.

## 5. Create and configure the Worker

Follow step 5 of the [publishing guide](../README.md) to import the public website repository into Cloudflare. The upload package includes the service under `website/worker/`; in the public repository it must be `worker/` at the repository root.

Before import, edit `worker/wrangler.toml` in GitHub with your website origin and private data repository details. In Cloudflare, use project name `thurstone-anniversary-submissions`, root directory `worker`, an empty build command, and deploy command `npx wrangler deploy`. The compatibility settings are already included in the configuration file.

After deployment, open Worker **Settings → Variables and Secrets** and add `GITHUB_TOKEN` and `TURNSTILE_SECRET` as **Secret** values, then deploy those changes. These are runtime secrets, not build-only variables.

| Name | Where to set it | Value |
| --- | --- | --- |
| `SITE_ORIGIN` | `wrangler.toml` under `[vars]` | `https://YOUR-USERNAME.github.io`, no trailing slash or path |
| `GITHUB_OWNER` | `wrangler.toml` | Account or organization owning the private data repository |
| `GITHUB_REPO` | `wrangler.toml` | `thurstone-anniversary-data` |
| `GITHUB_BRANCH` | `wrangler.toml` | `main` |
| `SUBMISSIONS_OPEN` | `wrangler.toml` | `true` |
| `GITHUB_TOKEN` | Cloudflare runtime secret | Token from step 3 |
| `TURNSTILE_SECRET` | Cloudflare runtime secret | Secret from step 4 |

Copy the production Worker's HTTPS address. Opening that address followed by `/guests` should return `[]` before there are responses. The root address returns “Not found”; it is a data service, not another website. Until all settings and secrets are present, the service deliberately refuses submissions.

### Terminal alternative

If you prefer a terminal, install a current supported Node.js version, edit the example values in `wrangler.toml`, then run these commands from the `worker` folder:

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```

The secret commands prompt for their values. Do not put secret values on the command line or in `wrangler.toml`. The first deploy may report unconfigured storage until the secrets have been added; it cannot save submissions in that state. These commands have not been run for you.

## 6. Connect the website

Update these fields in `config.js` and upload the updated file to the website repository:

```js
contactEmail: 'YOUR-ORGANIZER-EMAIL',
dataMode: 'github',
apiUrl: 'https://thurstone-anniversary-submissions.YOUR-SUBDOMAIN.workers.dev',
turnstileSiteKey: 'YOUR-PUBLIC-TURNSTILE-SITE-KEY'
```

Only public values belong here. The `apiUrl` must be an HTTPS origin with no path or trailing slash. Use the published website for testing the connected service; its origin is the one allowed by the Worker. Local preview remains available by setting `dataMode` back to `local` in your local copy.

## 7. Test before sending invitations

Use two browsers or one regular and one private window on the published website:

1. Submit an RSVP with a +1, email, and sample private requests. Confirm the private repository has the complete response. In the other browser, the guest list should show only the name, connection, lab years, and +1 status. Public-list caching can take up to 30 seconds to refresh.
2. Submit another response with public listing unchecked, and one declining attendance. Neither should appear publicly.
3. Try the first email again. It should reject the duplicate and direct the guest to organizers. There is no guest editing endpoint. A retry of the exact same submission within the original page is safe and does not create a second response.
4. Upload a small JPEG, PNG, or WebP through the website. It should confirm receipt but remain absent from the public gallery. Approve it using the organizer steps below, then confirm it becomes visible in the other browser.
5. Test a larger phone photo. The browser accepts originals up to 10 MB, resizes to at most 2,000 pixels, strips embedded EXIF data by re-encoding, and sends JPEG/WebP of at most 1 MiB. The Worker independently enforces size and signature checks. If Workers Free reports CPU-limit errors, investigate and test a smaller upload size before deciding whether to upgrade.
6. Check event details, contact link, navigation on a phone, and the Home Page Google Maps link.

## Organizer tasks

**Read or correct an RSVP:** open `data/rsvps.json` in the private repository. Each object is one response. Edit that object in GitHub, preserving valid JSON and its `id`, then commit. The email is for your organizer mailing workflow; this website does not send messages. Verify the guest's request before changing a response. The existing browser receipt is a confirmation of the original submission and does not automatically reflect organizer corrections.

**Guest list:** entries with `attendance: "yes"` and `public_listing: true` appear automatically. Only `name`, `role`, `years`, and `plus_one` are returned publicly. Do not add private details to these public fields. The public count excludes private RSVPs; use the private response file for the full attendee count, including +1s. The stated 160-person capacity is informational, not an automatic booking limit.

**Approve a photo:** open `data/photos.json`, find its `id`, and review the corresponding image in `photos/`. Change that object's `approved` value from `false` to `true` and commit. Newly approved photos appear after the gallery's cache refreshes. Pending photos are visible only to organizers in the private repository, not even in the uploader's public gallery.

**Unpublish a photo:** change `approved` back to `false`. The list may remain cached for 30 seconds and the image for up to 5 minutes. To remove its current stored files too, remove its metadata object and corresponding image. Git keeps commit history, so deleting current files does not erase earlier versions; plan private-data retention accordingly.

**Interrupted upload:** if an image write succeeds but its metadata write fails, it remains an unlisted private file. The guest sees an error rather than a success message. Compare `photos/` with IDs in `data/photos.json` to review or remove such orphan files. A retry can create a second pending image; review before approval.

**Close submissions:** change `SUBMISSIONS_OPEN` to `"false"` in the repository's `worker/wrangler.toml` and commit it; the connected Worker build deploys the change. With terminal deployment, update your local configuration and redeploy. Existing public lists and approved photos remain readable.

**Limits and maintenance:** renew the GitHub token before expiration and monitor Worker errors, GitHub API limits, and repository size. This event-sized implementation caps records at 500 RSVPs, 1,000 photo entries, and 900,000 bytes per JSON data file. Exceeding a limit reports an error without silently dropping existing responses. For a much larger archive, use storage designed for large photo collections. No paid storage binding is configured.

## Local verification

Run from the project root with Node.js:

```sh
node --test worker/worker.test.mjs
node --check app.js
node --check config.js
```

Tests use a simulated GitHub API and CAPTCHA service. They verify privacy projections, consent, duplicates, concurrent writes, private-repository enforcement, size limits, approvals, and error behavior. They do not replace testing a deployed Worker, real Turnstile widget, or your GitHub permissions.

Official references: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [GitHub file API](https://docs.github.com/en/rest/repos/contents), [Worker creation](https://developers.cloudflare.com/learning-paths/workers/get-started/first-worker/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Node Buffer support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/buffer/), [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
