# ⛳ Tee Times

A golf tee time board for sharing open spots with your crew. Built on Cloudflare Workers with KV storage.

## Features

- **Calendar view** — see tee times at a glance, color-coded by course
- **Post tee times** — pick course, date, time, and number of open spots (1-3)
- **Claim spots** — friends can join with one tap
- **Email notifications** — poster gets notified when someone joins or leaves
- **No auth needed** — just enter your name and email on first visit
- **Auto-cleanup** — tee times expire 30 days after their date

## Courses

- WeaverRidge
- Metamora Fields
- Coyote Creek
- Kellogg
- Madison
- Newman

## Stack

- Cloudflare Workers (single worker serves API + frontend)
- Cloudflare KV (data storage)
- MailChannels (email notifications, free on CF Workers)
- Vanilla JS frontend (no build step)

## Development

```bash
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```

## Custom Domain

Hosted at `teetimes.cmart073.com`
