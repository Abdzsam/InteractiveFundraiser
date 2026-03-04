# Fundraiser Configuration

Customize this tool in two ways:

1. Live in browser admin panel (press `A`) using **Live Settings JSON** + **Replace Default Image/GIF**.
2. By editing `/fundraiser.config.json` directly.

## Quick start

1. Open admin panel with `A`.
2. Use **Key Details**, **Secret Prize hint**, and **Price Ranges** forms, then click `Save`.
3. Use **Uploads** to replace:
   - QR image
   - Default media
   - Jackpot media
   - Any tier media (enter tier key + upload file)
4. Jackpot secret amount is intentionally hidden from the display admin panel.

If you edit `fundraiser.config.json` manually, restart the server (`npm start`) to reload it.

## Most common edits

- Secret jackpot number: `jackpot.secretAmount`
- Jackpot near-match tolerance: `jackpot.triggerTolerance`
- Campaign title/org/donate URL: `campaign.*`
- Currency + locale formatting: `campaign.currency`, `campaign.locale`
- Goal default: `campaign.goal`
- Tier thresholds + labels: `tiers[]`
- Banner/jackpot timing: `donationExperience.*`
- GIF speed + recent donor count: `display.*`

## Tier image mapping

Each `tiers[].tier` value maps to files in `public/gif/`:

- `tier: "1"` -> `public/gif/tier1.gif` (or `.png/.jpg/.webp/...`)
- `tier: "2point5"` -> `public/gif/tier2point5.gif` (or static image)

Default/jackpot media:

- `public/gif/default.gif` (or static image)
- `public/gif/jackpot.gif`
