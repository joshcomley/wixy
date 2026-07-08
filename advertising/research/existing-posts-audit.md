# Existing posts audit — Cottage Aesthetics (Facebook + Instagram)

> **Purpose**: ground the post-template design system ([03-creative-studio.md](../03-creative-studio.md))
> in Purdi's *actual current* look and voice. Her wording is sacred — nothing here is a
> suggestion to rewrite anything she's already written; it's a record of what she's already
> doing, so the template system fits her instead of the other way round.
>
> **Method**: headed Chrome (Playwright, `channel="chrome"`, `headless=False`, webdriver mask,
> no login at any point). Every fact below is tagged **SEEN** (rendered on-screen and read
> directly), **WALLED** (platform blocked it behind login), or **UNVERIFIED** (inferred/hinted,
> not directly observed). Audit run 2026-07-09.

## 0. Accounts

| Platform | URL used | Resolved identity | Verification |
|---|---|---|---|
| Facebook | `facebook.com/profile.php?id=61572079150383` | Redirects to `facebook.com/people/Cottage-Aesthetics/61572079150383/` — **no vanity slug exists**, it's a numeric-ID Page (confirmed via web search too: the only alternate URL found, `facebook.com/p/Cottage-Aesthetics-61572079150383/`, still embeds the same numeric ID) | SEEN |
| Instagram | `instagram.com/cottageaesthetics` | `@cottageaesthetics`, display name "Cottage Aesthetics" | SEEN |

Neither platform needed a login to see meaningful content. Both threw *soft* interstitials
(cookie banners, a QR-code login dialog on Facebook, a "sign up to see more" modal on
Instagram) that were dismissible (cookie decline button / Escape / a fixed-position scrim
found and hidden purely for clean screenshots, since the content behind it was already
proven publicly rendered by successful text extraction / a closable "X" on Instagram's
modal). The one genuine hard wall was **Instagram Story Highlights**, which redirect to a
"Sign up to see more story highlights" page with zero content (WALLED).

---

## 1. Screenshots captured

All saved to `advertising/research/existing-posts/`, PNG, longest side ≤ 1420px (all under
the 1800px cap). 20 total.

### Facebook (9 files)

| File | Description |
|---|---|
| `fb-01.png` | "Last few appointments remaining!" — July Prescription Clinic text-card graphic (posted ~3d before capture, i.e. ~6 Jul; zero engagement yet, very fresh) |
| `fb-02.png` | "The power of a subtle chin filler" — 4-photo real-client grid (chin/jaw, front + side), 30 Jun |
| `fb-03.png` | "Monthly Prescription Clinic — with Rav, our prescriber" — branded graphic + 2 clinic-interior photos + CTA band, 30 Jun |
| `fb-04.png` | "WIN A JALUPRO SH TREATMENT WORTH £150" — giveaway product graphic, 17 Jun (highest-engagement post found: 54 reactions / 65 comments / 92 shares) |
| `fb-05.png` | "Why did we choose to treat these lips over two sessions?" — 4-photo grid + live comment thread, 17 Jun |
| `fb-06.png` | "Why I Offer Free Consultations and No deposits" — long personal essay + a warm selfie of Purdi, signed "Purdi xxx", 31 May |
| `fb-07.png` | "No trout pout, lip shelf, or over-projection here." — explicit BEFORE/AFTER-labelled lip filler pair + comment thread, 30 May |
| `fb-08-reels-grid-and-cover.png` | Profile header — cover photo (styled clinic interior/reception) + profile picture (Purdi) + first row of the Reels grid with view counts |
| `fb-09-reels-grid-more.png` | Further Reels-grid rows — shows format range: selfie talk-to-camera, "what to expect" education, clinic interior, personal "Holiday" lifestyle content, seasonal Christmas-tree shot, an eye-concerns education graphic |

### Instagram (11 files)

| File | Description |
|---|---|
| `ig-01-testimonial-reel-microneedling.png` | Screen-recording-style Reel of a client's text message ("Purdi, I have to share you!! My skin is glowing…"), 17 May |
| `ig-02-prescriber-clinic-rav.png` | Dark-navy "Prescriber Clinic — Tuesday 2nd of June" card, 18 May |
| `ig-03-why-choose-dark-brand-card.png` | Dark-navy/gold-script "Why Choose Cottage Aesthetics?" credentials card, 20 May |
| `ig-04-elegance-lip-flip.png` | "Elegance lives in subtlety" — quote-style caption + 2 real lip photos, 21 May |
| `ig-05-me-38-vs-41-botox-reel.png` | Purdi's own personal before/after Reel (herself at 38 vs 41) — caption names "Botox" explicitly. **Compliance-relevant, see §6.** 28 May |
| `ig-06-microneedling-educational-reel.png` | "Thinking of getting a Microneedling Treatment? Here's what to expect…" educational Reel, real treatment-room photo, 17 May |
| `ig-07-giveaway-crosspost-comments.png` | Jalupro giveaway cross-post, showing live follower comments tagging friends ("GLOW @friend @friend") |
| `ig-08-no-trout-pout-crosspost.png` | Cross-post of `fb-07`, IG-side engagement (6 likes, 0 comments) |
| `ig-09-chin-filler-crosspost.png` | Cross-post of `fb-02`, IG-side engagement (1 like) |
| `ig-grid-01-profile-bio-highlights.png` | Profile header — cover-style top photo, profile picture, bio text, 2 Story Highlight bubbles ("MICRONEEDLING", "CLIENT CAM 📸"), first grid row |
| `ig-grid-02-more-posts.png` | Second grid row — close-up selfie, lip photo, the dark brand card, the prescriber card, and two Reel thumbnails |

---

## 2. Her voice — verbatim caption samples

13 unique captions transcribed **exactly as written** (all SEEN, rendered logged-out).
Six of these are identical cross-posts between Facebook and Instagram (noted); seven appear
on only one platform. Bold/italic-looking words are her own styling — she hand-formats
headlines using Unicode "mathematical alphanumeric" bold/italic characters (a manual
workaround for FB/IG captions having no native rich text), not a real typeface. Emoji are
present in the true rendered text even where a couple of my plain-text dumps initially
dropped them — cross-checked against screenshots and reconciled below.

> **FB-1** · posted ~6 Jul (fresh, 0 engagement yet)
> 𝙇𝙖𝙨𝙩 𝙛𝙚𝙬 𝙖𝙥𝙥𝙤𝙞𝙣𝙩𝙢𝙚𝙣𝙩𝙨 𝙧𝙚𝙢𝙖𝙞𝙣𝙞𝙣𝙜!
> Cottage Aesthetic's July Prescription Clinic is taking place this Tuesday, the 7th of July, from 5:00pm–8:00pm, and we only have a handful of consultation slots left!
> Get in touch to book your appointment.
> #cottageaestheticshartlebury #advancedaesthetics #nursepractitioner #hartlebury #kidderminster

> **FB-2 / IG-dupe (`ig-09`)** · 30 Jun · FB: 11 reactions / 24 shares · IG: 1 like
> 𝗧𝗵𝗲 𝗽𝗼𝘄𝗲𝗿 𝗼𝗳 𝗮 𝘀𝘂𝗯𝘁𝗹𝗲 𝗰𝗵𝗶𝗻 𝗳𝗶𝗹𝗹𝗲𝗿 💉
> A carefully placed chin filler can soften and feminise your profile while creating better balance and harmony across your face.
> It can also help define and elongate the jawline, improve facial proportions, and restore symmetry for a naturally enhanced look.
> If you've been put off by overfilled or overly pointed examples you've seen online, don't worry.
> At Cottage Aesthetics, every treatment is tailored to your unique facial anatomy, with a focus on balance, symmetry, and subtle, natural-looking results.
> The best aesthetic treatments don't change how you look, they simply enhance the beautiful features you already have.
> Pop in for a FREE consultation or book in for treatment using the link below ⬇️
> 𝗵𝘁𝘁𝗽𝘀://𝗳𝗮𝗰𝗲𝘀𝗰𝗼𝗻𝘀𝗲𝗻𝘁.𝗰𝗼𝗺/𝗯𝗼𝗼𝗸𝗶𝗻𝗴𝘀/𝗽𝘂𝗿𝗱𝗶-𝗵𝗮𝗱𝗹𝗲𝘆
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics #kidderminster #droitwich

> **FB-3 / IG-dupe (`ig-07`-adjacent post)** · 30 Jun · FB: 7 reactions / 51 shares · IG: 4 likes
> 𝐍𝐞𝐱𝐭 𝐏𝐫𝐞𝐬𝐜𝐫𝐢𝐩𝐭𝐢𝐨𝐧 𝐂𝐥𝐢𝐧𝐢𝐜 – 𝐓𝐮𝐞𝐬𝐝𝐚𝐲 𝟕𝐭𝐡 𝐉𝐮𝐥𝐲 ✨ *(✨ appears on the IG copy only)*
> Appointments available 5:00–8:00pm.
> A consultation is required to assess your suitability for prescription-only treatments.
> Limited appointments available. Message to book your consultation.
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics

> **FB-4 / IG-dupe (`ig-07`)** · 17 Jun · FB: 54 reactions / 65 comments / 92 shares · IG: 18 likes / 50 comments — **the single best-performing post found on either platform**
> ✨ 𝐖𝐈𝐍 𝐀 𝐉𝐀𝐋𝐔𝐏𝐑𝐎 𝐒𝐇 𝐓𝐑𝐄𝐀𝐓𝐌𝐄𝐍𝐓 𝐖𝐎𝐑𝐓𝐇 £𝟏𝟓𝟎 ✨
> If I could choose just one injectable treatment for skin quality, this would be it.
> Jalupro Super Hydro is my most requested skin booster, and honestly, I credit much of my own skin's glow and quality to this incredible treatment.
> More than just a glow booster, it helps improve skin quality from within, restoring moisture, restoring the skins fibroblasts, improving elasticity and leaving skin firmer, tighter and more resilient. Clients often notice a healthy radiance, improved hydration, a subtle lifting effect and softer lines, all while maintaining a natural, refreshed, glowy appearance.
> 𝙄𝙩'𝙨 𝙤𝙣𝙚 𝙤𝙛 𝙩𝙝𝙤𝙨𝙚 𝙩𝙧𝙚𝙖𝙩𝙢𝙚𝙣𝙩𝙨 𝙩𝙝𝙖𝙩 𝙘𝙡𝙞𝙚𝙣𝙩𝙨 𝙚𝙭𝙥𝙚𝙧𝙞𝙚𝙣𝙘𝙚 𝙤𝙣𝙘𝙚 𝙖𝙣𝙙 𝙬𝙖𝙣𝙩 𝙩𝙤 𝙝𝙖𝙫𝙚 𝙖𝙜𝙖𝙞𝙣.
> As I rarely run giveaways, I thought it was time to treat one of you to my favourite skin treatments. 🤍
> ✨ 𝐓𝐨 𝐞𝐧𝐭𝐞𝐫: *(FB numbers the 4 steps "1. 2. 3. 4."; IG bullets them with 🤍 instead — otherwise identical)*
> 1. Follow the Cottage Aesthetics page!!!
> 2. Like this post
> 3. Comment "GLOW" below
> 4. Invite/tag your friends or family to do the same!
> The winner will be announced on the 13th of July!
> Good Luck 🍀 *(FB) / 🤞🏻 (IG — the sign-off emoji differs slightly between the two platform copies)*
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics #hartlebury #kidderminster

> **FB-5 / IG-dupe (`ig-07` text)** · 17 Jun · FB: 12 reactions / 2 comments · IG: 5 likes
> 𝐖𝐡𝐲 𝐝𝐢𝐝 𝐰𝐞 𝐜𝐡𝐨𝐨𝐬𝐞 𝐭𝐨 𝐭𝐫𝐞𝐚𝐭 𝐭𝐡𝐞𝐬𝐞 𝐥𝐢𝐩𝐬 𝐨𝐯𝐞𝐫 𝐭𝐰𝐨 𝐬𝐞𝐬𝐬𝐢𝐨𝐧𝐬? 👄
> At Cottage Aesthetics, I understand that aesthetic treatments can feel daunting.
> It's completely normal to worry about looking overdone, obvious, or making a change you'll later regret.
> That's why here, there is never any pressure to do too much, too soon.
> Every treatment is tailored to your comfort level and aesthetic goals. If you'd prefer to take a gradual approach, building your results slowly over multiple appointments, I will fully support that journey.
> Sometimes the most beautiful outcomes come from making small, thoughtful changes over time.
> This client wanted increased fullness and improved balance while maintaining a natural appearance and avoiding an overly projected or overfilled look. By working over two sessions, we were able to achieve a soft, harmonious result that respected her features and gave her confidence in every step of the process.
> Your treatment, your pace, your choice. 🤍
> Free Consultations - booking link below ⬇️
> 𝙝𝙩𝙩𝙥𝙨://𝙛𝙖𝙘𝙚𝙨𝙘𝙤𝙣𝙨𝙚𝙣𝙩.𝙘𝙤𝙢/𝙗𝙤𝙤𝙠𝙞𝙣𝙜𝙨/𝙥𝙪𝙧𝙙𝙞-𝙝𝙖𝙙𝙡𝙚𝙮
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics #hartlebury #kidderminster
>
> Comment thread (FB): Lisa Marie — *"I love them Purdi 🧡🧡 you really are the best xx"* (3w, 1 like) → Purdi (Author reply) — *"Lisa Marie they look beautiful! 😍"*

> **FB-6 / IG-dupe (`ig-02` post)** · 31 May · FB: 28 reactions / 20 shares · IG: 14 likes
> 𝗪𝗵𝘆 𝗜 𝗢𝗳𝗳𝗲𝗿 𝗙𝗿𝗲𝗲 𝗖𝗼𝗻𝘀𝘂𝗹𝘁𝗮𝘁𝗶𝗼𝗻𝘀 𝗮𝗻𝗱 𝗡𝗼 𝗱𝗲𝗽𝗼𝘀𝗶𝘁𝘀
> As an aesthetics nurse, it's important to me that every client feels informed, safe, comfortable and free to make the decisions that are right for them.
> That's why consultations are always free, and I don't take deposits for treatments.
> I believe consultations should be a safe space to ask questions, discuss concerns, explore options and understand what's realistically achievable. They're about education, transparency and honest advice — not sales.
> I also choose not to take deposits because I never want anyone to feel committed to a treatment simply because money is tied up in a booking. If you decide a treatment isn't right for you, need more time to think, or your priorities change, that's absolutely okay.
> While many clinics charge for consultations or require deposits, I've always believed that trust and informed decision-making should come first.
> The only thing I ask in return is that, where possible, you give at least 24 hours' notice if you need to cancel or rearrange an appointment. As a small independent business, late cancellations and no-shows can have a big impact, especially when other clients are waiting for appointments.
> I completely understand that life happens, and if an emergency arises, a quick message is always appreciated.
> Thank you for respecting my time as much as I respect yours, and for trusting me with your care. 🧡
> **Purdi xxx**
> Cottage Aesthetics

> **FB-7 / IG-dupe (`ig-08`)** · 30 May · FB: 13 reactions / 2 comments / 20 shares · IG: 6 likes
> 𝙉𝙤 𝙩𝙧𝙤𝙪𝙩 𝙥𝙤𝙪𝙩, 𝙡𝙞𝙥 𝙨𝙝𝙚𝙡𝙛, 𝙤𝙧 𝙤𝙫𝙚𝙧-𝙥𝙧𝙤𝙟𝙚𝙘𝙩𝙞𝙤𝙣 𝙝𝙚𝙧𝙚. 👄
> When placed with skill and precision, dermal fillers can beautifully enhance your natural features without looking obvious.
> If you've been hesitant about lip enhancement because of a few less-than-natural examples you've seen, it may be time to think again.
> At Cottage Aesthetics, the focus is on subtle, natural-looking enhancements that complement your features and help you feel your most confident and beautiful.
> This treatment is only £130 and results can last between 1-3 years!
> Book a free consultation or treatment via the link ⬇️
> 𝗵𝘁𝘁𝗽𝘀://𝗳𝗮𝗰𝗲𝘀𝗰𝗼𝗻𝘀𝗲𝗻𝘁.𝗰𝗼𝗺/𝗯𝗼𝗼𝗸𝗶𝗻𝗴𝘀/𝗽𝘂𝗿𝗱𝗶-𝗵𝗮𝗱𝗹𝗲𝘆
> #cottageaestheticshartlebury #advancedaesthetics #nurseinjector #kidderminster #hartlebury
>
> Comment thread (FB): Lisa Marie — *"I love them so much!! Thank you Purdi ❤️❤️"* (5w) → Purdi (Author reply) — *"Lisa Marie I am so glad! Thank you for trusting me! 🧡"*

> **IG-only #1** (17 May, 10 likes) — short-form, paired with a client-testimonial screen-recording Reel
> I love getting post-treatment messages like this! 🥰
> The Microneedling glow is incredible!
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics #microneedling #hartlebury

> **IG-only #2** (18 May) — note "Rav" is called *"our pharmacist"* here vs *"our prescriber"* on the FB version of the same clinic-day series
> 𝐏𝐫𝐞𝐬𝐜𝐫𝐢𝐩𝐭𝐢𝐨𝐧 𝐂𝐥𝐢𝐧𝐢𝐜 𝐚𝐭 𝐂𝐎𝐓𝐓𝐀𝐆𝐄 𝐀𝐄𝐒𝐓𝐇𝐄𝐓𝐈𝐂𝐒
> If you have concerns about fine lines and wrinkles, book a consultation with myself, and our pharmacist, Rav, to discuss your individual needs and explore suitable treatment options following assessment.
> Our next prescriber clinic is taking place on Tuesday the 2nd of June from 17:30-20:00.
> Welcoming both new and returning clients.
> 𝐀𝐩𝐩𝐨𝐢𝐧𝐭𝐦𝐞𝐧𝐭𝐬 𝐚𝐫𝐞 𝐥𝐢𝐦𝐢𝐭𝐞𝐝 𝐬𝐨 𝐛𝐨𝐨𝐤𝐢𝐧𝐠 𝐢𝐬 𝐄𝐬𝐬𝐞𝐧𝐭𝐢𝐚𝐥!
> 📞 07401 562 462
> https://facesconsent.com/bookings/purdi-hadley
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics

> **IG-only #3** (20 May, 11 likes) — the dark-brand-card copy
> 𝐀𝐭 𝐂𝐎𝐓𝐓𝐀𝐆𝐄 𝐀𝐄𝐒𝐓𝐇𝐄𝐓𝐈𝐂𝐒, every treatment is delivered with a medical-led, regulated approach, grounded in dermatology & plastic surgery experience, 15 years of nursing knowledge, and advanced aesthetics training.
> Cottage Aesthetics is built on the belief that beautiful aesthetic results come from true medical expertise, genuine care for achieving your goals safely and pricing that always remains fair and accessible.
> 🤍 Free consultations
> 🤍 Premium products
> 🤍 Private clinic setting
> 🤍 Natural, refined results
> 🤍 Honest, accessible pricing
> 🤍 NMC Regulated and Insured
> Booking Link ⬇️
> 𝗵𝘁𝘁𝗽𝘀://𝗳𝗮𝗰𝗲𝘀𝗰𝗼𝗻𝘀𝗲𝗻𝘁.𝗰𝗼𝗺/𝗯𝗼𝗼𝗸𝗶𝗻𝗴𝘀/𝗽𝘂𝗿𝗱𝗶-𝗵𝗮𝗱𝗹𝗲𝘆
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics #kidderminster hartlebury

> **IG-only #4** (21 May, 3 likes) — her most "editorial"/poetic opener found
> "𝙀𝙡𝙚𝙜𝙖𝙣𝙘𝙚 𝙡𝙞𝙫𝙚𝙨 𝙞𝙣 𝙨𝙪𝙗𝙩𝙡𝙚𝙩𝙮"
> And at COTTAGE AESTHETICS, our goal is to enhance not overpower.
> A gentle lip flip and/or carefully placed dermal filler can create the understated, classy lip enhancement your lips deserve.
> 𝙒𝙚 𝙡𝙤𝙫𝙚 𝙡𝙞𝙥𝙨 𝙩𝙝𝙖𝙩 𝙖𝙧𝙚 𝙨𝙤𝙛𝙩, 𝙗𝙖𝙡𝙖𝙣𝙘𝙚𝙙 𝙖𝙣𝙙 𝙗𝙚𝙖𝙪𝙩𝙞𝙛𝙪𝙡𝙡𝙮 𝙣𝙖𝙩𝙪𝙧𝙖𝙡.
> If you feel your lips have lost volume but worry about looking overdone, you can trust me to listen carefully and work with you to create results that feel comfortable, natural and completely tailored to you. 🤍
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics

> **IG-only #5 — Reel** (28 May, 24 likes / 2 comments) — her own personal before/after. **See §6 — names a POM by name.**
> 𝙏𝙝𝙞𝙨 𝙗𝙚𝙛𝙤𝙧𝙚 𝙖𝙣𝙙 𝙖𝙛𝙩𝙚𝙧 𝙞𝙨 𝙤𝙛 𝙢𝙚! 😮 🫣
> Taken two years apart!
> The first photo is me at 38 and the other at 41!!!
> At the point of my first picture, I had only ever had occasional Botox treatments for special events and hadn't explored any other aesthetic treatments.
> What I've learnt since starting my own aesthetics journey is that 𝐜𝐨𝐧𝐬𝐢𝐬𝐭𝐞𝐧𝐜𝐲, 𝐪𝐮𝐚𝐥𝐢𝐭𝐲 𝐩𝐫𝐨𝐝𝐮𝐜𝐭𝐬, 𝐚𝐧𝐝 𝐞𝐱𝐩𝐞𝐫𝐢𝐞𝐧𝐜𝐞 really do matter.
> Subtle, well-planned treatments over time can make a huge difference to overall skin quality, symmetry, confidence, and how refreshed you look and feel.
> At Cottage Aesthetics, every journey is individual and tailored uniquely to you. It is 𝐧𝐞𝐯𝐞𝐫 𝐭𝐨𝐨 𝐥𝐚𝐭𝐞!
> Whether your goal is prevention, skin health, hydration, or softening signs of ageing, treatments should always be personalised and approached naturally.
> Book a free consultation to discuss how I can help you too. ⬇️
> #cottageaestheticshartlebury #nursepractitioner #advancedaesthetics #hartlebury #worcestershire
>
> Comments: wearespiritrituals — *"Glowing 😍 need to rebook my Microneedling!!"*; home_near_the_severn — *"Will book after hols"*

> **IG-only #6 — Reel** (17 May, 5 likes) — her most detailed educational format, itemised + priced
> 𝐌𝐢𝐜𝐫𝐨𝐧𝐞𝐞𝐝𝐥𝐢𝐧𝐠 𝐚𝐭 𝐂𝐎𝐓𝐓𝐀𝐆𝐄 𝐀𝐄𝐒𝐓𝐇𝐄𝐓𝐈𝐂𝐒
> Microneedling is a skin rejuvenation treatment that uses a medical-grade derma-pen with tiny sterile needles to create controlled micro-injuries in the skin.
> This stimulates the body's natural healing response, encouraging collagen and elastin production to improve overall skin texture, tone, and appearance.
> 𝘽𝙚𝙣𝙚𝙛𝙞𝙩𝙨 𝙤𝙛 𝙈𝙞𝙘𝙧𝙤𝙣𝙚𝙚𝙙𝙡𝙞𝙣𝙜 𝙞𝙣𝙘𝙡𝙪𝙙𝙚: *(bulleted list of 6 benefits)* … 𝙔𝙤𝙪𝙧 𝙩𝙧𝙚𝙖𝙩𝙢𝙚𝙣𝙩 𝙞𝙣𝙘𝙡𝙪𝙙𝙚𝙨: *(bulleted 9-step treatment protocol)*
> 𝐒𝐭𝐚𝐧𝐝𝐚𝐫𝐝 𝐌𝐢𝐜𝐫𝐨𝐧𝐞𝐞𝐝𝐥𝐢𝐧𝐠 £30
> 𝐀𝐝𝐯𝐚𝐧𝐜𝐞𝐝 𝐌𝐢𝐜𝐫𝐨𝐧𝐞𝐞𝐝𝐥𝐢𝐧𝐠. £80
> Message for any further queries or book your treatment using the Link below ⬇️

**Recurring voice fingerprints across all 13**: a bold/italic Unicode headline as line 1;
short punchy paragraphs (1-3 sentences) separated by blank lines; a rhetorical question or
reassurance-first opener ("Why did we...", "No trout pout...", "Why I offer...") that
pre-empts a client objection before selling; the phrase **"natural, subtle, never overdone"**
recurs in some form in nearly every treatment post; free-consultation CTA + the same booking
link in almost every post; consistent hashtag core
(`#cottageaestheticshartlebury #nursepractitioner #advancedaesthetics` + a rotating pair of
`#hartlebury #kidderminster #droitwich #worcestershire`); sparing, warm emoji (🧡 🤍 👄 😍 🥰 ✨ 💉 ⬇️) — never emoji-spam; she personally replies to comments in first person and signs longer/personal posts "**Purdi xxx**".

---

## 3. Format inventory

**Post types observed (SEEN)**:
- **Branded text/graphic cards** (Canva-style) — the single most common format. Two
  *different* visual templates are in circulation (see §5): a light cream/olive "cottage"
  template for clinic-hours/announcement cards, and a separate dark-navy + gold-script
  "editorial" template for credential/"why choose us" cards.
- **Real client photography, close-cropped to the treated area only** (chin/jaw, lips) —
  never full-face, never stock imagery. Usually a 2-4 photo grid (front + side angle,
  sometimes a second grid for before/after).
- **Before/after pairs** — sometimes explicitly labelled "BEFORE"/"AFTER" baked into the
  image (fb-07), sometimes just two photos side by side relying on the caption to explain
  (fb-05, the IG lip-flip post).
- **Personal selfies of Purdi** — both as standalone posts (fb-06) and as the photo on
  branded cards (fb-03, ig-02, ig-03).
- **Reels** — a genuine second content stream, at least 20 visible on Facebook (view counts
  553–7,200) and further reels on Instagram. Sub-formats spotted: talk-to-camera
  face closeups; "what to expect" treatment-process education (real footage of a client
  being treated); a screen-recording of a client's text message read as a testimonial;
  personal before/after (herself, 2-years-apart); seasonal/lifestyle asides (a Christmas
  tree in the clinic doorway, a "Holiday" coastal-sunset clip — these are *not*
  treatment content, more personality/relatability); a "DARK CIRCLES / UNDER-EYE
  PUFFINESS / FINE LINES / CREPEY" problem-education graphic reel.
- **Giveaway/engagement-mechanic posts** — one observed (Jalupro SH), "comment a word +
  tag friends" structure, by far her highest-reach post.
- **No plain text-only posts, no third-party shares, no carousels observed** in the visible
  window (Facebook carousels may exist further back — UNVERIFIED, wall reached before more
  could be confirmed).

**Music on reels**: not verifiable — reels render as static thumbnails in the logged-out
grid view; opening one autoplays but audio-track identification wasn't pursued (out of
scope for a screenshot-based audit and not reliably readable without playing each clip).
**UNVERIFIED.**

**Text-on-image styling**: consistent device — a bold/italic serif or sans headline (using
Unicode "mathematical alphanumeric" characters, not a real embedded font), icon rows
(calendar/clock/pin icons) on appointment cards, a thin gold/brass divider line under the
"COTTAGE AESTHETICS" wordmark on the light-template cards, and a cream-on-taupe CTA band
at the bottom of announcement cards ("GET IN TOUCH NOW TO book your consultation.").

---

## 4. Cadence + engagement signals

**Cadence** (SEEN, from the 13 unique dated items): 17 May, 17 May, 18 May, 20 May, 21 May,
28 May, 30 May, 31 May, 17 Jun ×2, 30 Jun ×2, ~6 Jul — i.e. content spanning **17 May → 6
Jul (≈7.5 weeks)** at roughly **1.7 unique posts/week**, before accounting for
Facebook-only Reels (20 visible, undated) and the ~221 older Instagram posts not reachable
logged-out. Clusters of 2 same-day posts appear around clinic days (30 Jun, 17 Jun) — she
posts a reminder *and* a treatment-education piece around each prescriber-clinic date.

**Follower counts** (SEEN):
- Facebook: **1.2K followers**, 23 following, "100% recommend (25 reviews)"
- Instagram: **367 followers**, 20 following, **233 posts total** (from the page's own meta
  description — SEEN in the rendered document, though most of that history is unreachable
  logged-out; only the most recent ~12 render in the anonymous grid)

**Engagement** (SEEN, raw numbers per post):

| Post | FB reactions/comments/shares | IG likes/comments |
|---|---|---|
| Chin filler | 11 / — / 24 | 1 / 0 |
| Prescriber clinic (30 Jun) | 7 / — / 51 | 4 / 0 |
| Jalupro giveaway | 54 / 65 / 92 | 18 / 50 |
| Lips over two sessions | 12 / 2 / — | 5 / 0 |
| Free consultations essay | 28 / — / 20 | 14 / 0 |
| No trout pout | 13 / 2 / 20 | 6 / 0 |
| Me at 38 vs 41 (Reel) | — (FB copy not found) | 24 / 2 |

Facebook is clearly the larger, more-engaged audience day-to-day; the giveaway mechanic
produced by far the biggest spike on both platforms (11-20× the typical comment count),
concentrated in visible tag-a-friend chains. Non-giveaway engagement is modest but
consistent (roughly 1-3% of the follower base reacting), and she personally replies to
comments rather than leaving them unanswered.

---

## 5. Design read

**Observations on her current aesthetic**:
1. **Two competing visual template families are in play**, not one system: a light
   cream/olive/clay "cottage" template (line-drawn house icon, script accent, warm
   neutrals — this one already matches the brand's described cottage/calm identity closely)
   for clinic-hours cards, and a separate dark-navy-and-gold "editorial" template for
   credential/"why choose us" cards. They don't yet read as the same brand.
2. **Real, unfiltered clinical photography dominates over stock imagery** — close crops on
   the treated area only (never full face), which is both an authenticity strength and a
   privacy-conscious habit worth preserving exactly.
3. **She is a visible, warm presence on camera** — selfies, reels, and her photo on branded
   cards appear constantly. Personal trust-building is already core to her existing
   strategy, well aligned with the brand's "nurse-led trust" positioning.
4. **Before/after framing is inconsistent** — one post bakes literal "BEFORE"/"AFTER" labels
   into the image; others just place two photos side by side and let the caption carry the
   meaning.
5. **Headline "typography" is a manual Unicode hack**, not a real embedded brand typeface —
   she's clearly reaching for a designed look with the tools Facebook/Instagram give her
   (bold/italic caption text), but it's a workaround, not real typography, and is invisible
   to screen readers.
6. **No visible consent/compliance microcopy on any before/after post** (e.g. no "shared
   with consent" label), despite consistently using genuine client images.
7. **Cross-posting is copy-paste identical** between Facebook and Instagram — same graphic,
   near-identical caption (only tiny emoji differences) — no platform-specific
   optimisation (Reels-first framing for IG, longer-form for FB, etc.).
8. **The color/type formula on the light template is already good** — cream background,
   olive/taupe accent band, thin brass/gold divider, soft serif display headline, small
   line-icon logo mark — a strong, ready-to-formalise foundation.

**Opportunities for the template system**:
1. **Unify the two template families** into one system driven by the site's actual
   `theme.json` tokens (Cormorant Garamond / Jost / Pinyon Script, cream/olive/clay), so
   every post — announcement, before/after, quote, credential card — shares one palette,
   type scale and logo treatment.
2. **Standardise before/after framing**: one consistent crop convention, consistent
   BEFORE/AFTER label placement/typography, and a consistent consent-disclosure line,
   applied automatically by the template rather than done by hand per-post.
3. **Replace the Unicode bold/italic hack with real rendered typography** — since layouts
   are HTML/CSS rendered headlessly (per [03 §2](../03-creative-studio.md#2-the-post-composer-the-core-flow--three-steps-no-more)),
   headlines can use the actual brand font, crisp and accessible, instead of a manual
   character-substitution trick.
4. **Give her a compliance nudge at the point of writing** — her organic posts already
   reference "prescription-only treatments" by category and, in one Reel, name a POM
   directly (§6); the planned linter should flag this *before* publish without touching her
   wording.
5. **Turn her already-loved "client message" testimonial format into a proper template** —
   the screen-recording-of-a-text-message Reel gets warm engagement and is clearly a
   favourite of hers; a branded frame around it (consistent border, consistent caption
   placement) would make it feel designed without changing what it fundamentally is.

---

## 6. Compliance observations (flag only — no judgement, for the studio's linter to action)

- **A Reel names a POM directly**: her personal before/after post (`ig-05-me-38-vs-41-botox-reel.png`,
  28 May) states *"I had only ever had occasional Botox treatments for special events"* —
  this names botulinum toxin by brand-adjacent common name in an organic, public,
  clinic-branded post.
- **"Prescription-only treatments" is named (by category, not drug) in two posts**:
  `fb-03.png`/`ig-02` ("A consultation is required to assess your suitability for
  prescription-only treatments") and the Instagram-only Prescriber Clinic post ("If you
  have concerns about fine lines and wrinkles, book a consultation with myself, and our
  pharmacist, Rav…").
- **A named team member's role is described inconsistently**: "Rav" is called **"our
  prescriber"** on the Facebook version of a clinic-day post and **"our pharmacist"** on the
  Instagram version of the same clinic-day series — a factual inconsistency worth
  reconciling regardless of the compliance angle.
- **Before/after imagery appears in at least 4 distinct posts** (`fb-02` chin filler,
  `fb-05`/IG-dupe lips-over-two-sessions, `fb-07`/IG-dupe explicitly-labelled lip filler,
  `ig-04` elegance lip-flip) with **no visible consent-disclosure microcopy** on any of
  them (the regulatory-guardrails doc's suggested "Real client, shared with consent"
  wording does not currently appear anywhere observed).
- **The giveaway mechanic ties an incentive (a free £150 treatment) to
  follow/like/comment/tag-friends actions** on a post promoting a specific injectable
  treatment (Jalupro Super Hydro) — flagged as a fact pattern for the studio's incentive
  rules to evaluate, no verdict offered here.
- **Purdi's own before/after Reel is itself a before/after post** (of herself) naming a POM
  — i.e. the same post triggers two separate flag categories at once (before/after rules +
  POM-naming rules).

---

## Appendix — what stayed walled / unverified

- **Instagram Story Highlights** ("MICRONEEDLING", "CLIENT CAM 📸") — titles SEEN, content
  fully WALLED (redirects to a "Sign up to see more story highlights" page with nothing
  else rendered).
- **The ~221 older Instagram posts** beyond the 12 that render in the logged-out grid —
  UNVERIFIED / unreachable without login (Instagram hard-caps anonymous grid pagination).
- **Facebook posts older than 30 May** — UNVERIFIED; the logged-out feed terminates in an
  inline "log in to see more" wall right after the 30 May post with no further pagination
  available.
- **The second link in the Instagram bio** ("facesconsent.com/bookings/purdi-hadley **and 1
  more**") — the additional linked destination was not opened. UNVERIFIED.
- **Reel audio/music tracks** — not identified (see §3). UNVERIFIED.
- **Facebook Reviews tab content** (behind the "100% recommend, 25 reviews" figure) — not
  opened; that figure itself is SEEN but the review text is UNVERIFIED.
