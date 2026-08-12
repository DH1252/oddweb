export type SiteFact = {
  label: string
  value: string
}

export type SiteEntry = {
  slug: string
  name: string
  externalUrl: string
  description: string
  summary: string
  tags: string[]
  categories: string[]
  poster: string
  notes: string[]
  facts: SiteFact[]
  visits: number
  added: string
  addedLabel: string
  accent: string
  thumbnailKey?: string
  thumbnailAlt?: string
}

export type RecentFiling = {
  name: string
  url: string
  description: string
  tags: string[]
  date: string
  thumbnailKey?: string
  thumbnailAlt?: string
}

export const sites: SiteEntry[] = [
  {
    slug: 'radio-garden',
    name: 'Radio Garden',
    externalUrl: 'https://radio.garden/',
    description:
      'A globe you spin to hear live radio from anywhere in the world.',
    summary:
      'Spin a globe and tune into live radio stations from almost anywhere.',
    tags: ['listen', 'music', 'radio', 'world', 'map', 'wander'],
    categories: ['Listen', 'Wander', 'Live'],
    poster: 'TUNE EARTH',
    notes: [
      'Radio Garden turns internet radio into a map. Move around the globe, choose a green station marker, and listen to a local broadcast.',
      'Pick this when you want music, voices, or local atmosphere without deciding on a genre first.',
    ],
    facts: [
      { label: 'Mode', value: 'Listen and explore' },
      { label: 'Input', value: 'Map navigation' },
      { label: 'Address', value: 'radio.garden' },
    ],
    visits: 187,
    added: '2026-07-28',
    addedLabel: 'Jul 28',
    accent: 'from-[#315c51] to-[#79a381]',
  },
  {
    slug: 'neal-fun',
    name: 'Neal.fun',
    externalUrl: 'https://neal.fun/',
    description: 'A pile of small, playful little browser experiments.',
    summary:
      'Small interactive experiments about space, money, scale, and everything between.',
    tags: ['play', 'experiments', 'games', 'interactive', 'educational', 'fun'],
    categories: ['Play', 'Experiments', 'Collection'],
    poster: 'PLAY LAB',
    notes: [
      'A growing cabinet of browser experiments. Each project explains an idea through scrolling, clicking, drawing, or playing.',
      'Pick this when you want a short interactive detour but do not know which subject you are in the mood for.',
    ],
    facts: [
      { label: 'Mode', value: 'Play and learn' },
      { label: 'Input', value: 'Varies by experiment' },
      { label: 'Address', value: 'neal.fun' },
    ],
    visits: 154,
    added: '2026-07-30',
    addedLabel: 'Jul 30',
    accent: 'from-[#38578d] to-[#eabc52]',
  },
  {
    slug: 'window-swap',
    name: 'Window Swap',
    externalUrl: 'https://www.window-swap.com/',
    description:
      "Look through a stranger's window somewhere in the world for a while.",
    summary:
      "Borrow someone else's window view for a quiet moment somewhere new.",
    tags: ['wander', 'windows', 'travel', 'calm', 'views', 'world', 'video'],
    categories: ['Wander', 'Video', 'Calm'],
    poster: 'LOOK OUT',
    notes: [
      'A collection of recorded views through windows around the world. Each change places you in a different room, city, climate, and everyday soundscape.',
      'Pick this when you want to travel briefly without a map, itinerary, or task.',
    ],
    facts: [{ label: 'Address', value: 'window-swap.com' }],
    visits: 122,
    added: '2026-08-01',
    addedLabel: 'Aug 1',
    accent: 'from-[#527797] to-[#d8a866]',
  },
  {
    slug: 'patatap',
    name: 'Patatap',
    externalUrl: 'https://patatap.com/',
    description: 'Press any key to make a sound and a shape.',
    summary:
      'Turn your keyboard into a bright, animated instrument of sound and shape.',
    tags: [
      'play',
      'listen',
      'sound',
      'music',
      'keyboard',
      'visual',
      'art',
      'interactive',
    ],
    categories: ['Play', 'Listen', 'Keyboard'],
    poster: 'TAP / TONE',
    notes: [
      'An audiovisual instrument in the browser. Press letter keys to trigger paired sounds and animated shapes, then combine them into loose rhythms.',
      'Pick this when you want to make something immediately without instructions or setup.',
    ],
    facts: [
      { label: 'Mode', value: 'Play and listen' },
      { label: 'Input', value: 'Keyboard' },
      { label: 'Address', value: 'patatap.com' },
    ],
    visits: 96,
    added: '2026-08-02',
    addedLabel: 'Aug 2',
    accent: 'from-[#dc4f33] to-[#e9b640]',
  },
  {
    slug: 'mapcrunch',
    name: 'MapCrunch',
    externalUrl: 'https://www.mapcrunch.com/',
    description:
      'Drops you on a random street somewhere, and you figure out where.',
    summary:
      'Drop into a random Street View and work out where on Earth you landed.',
    tags: ['wander', 'maps', 'travel', 'random', 'street', 'view', 'world'],
    categories: ['Wander', 'Maps', 'Random'],
    poster: 'LOST, NICELY',
    notes: [
      'A random doorway into Street View. You might land on a quiet road, a city block, or a landscape with few clues about its location.',
      'Pick this when getting pleasantly lost sounds better than searching for a destination.',
    ],
    facts: [
      { label: 'Mode', value: 'Explore and guess' },
      { label: 'Input', value: 'Street View controls' },
      { label: 'Address', value: 'mapcrunch.com' },
    ],
    visits: 81,
    added: '2026-08-03',
    addedLabel: 'Aug 3',
    accent: 'from-[#586f44] to-[#c4a866]',
  },
  {
    slug: 'zoomquilt',
    name: 'Zoomquilt',
    externalUrl: 'https://zoomquilt.org/',
    description: 'A painting that keeps zooming into new scenes, forever.',
    summary:
      'An endlessly zooming collaborative painting that keeps opening into itself.',
    tags: ['odd', 'art', 'infinite', 'zoom', 'surreal', 'visual', 'calm'],
    categories: ['Pure oddity', 'Art', 'Infinite'],
    poster: 'KEEP GOING',
    notes: [
      'A continuous journey through connected surreal scenes. The image keeps moving inward, revealing another room, landscape, or creature.',
      'Pick this when you want a visual loop to watch rather than a task to complete.',
    ],
    facts: [
      { label: 'Mode', value: 'Watch and drift' },
      { label: 'Input', value: 'Optional controls' },
      { label: 'Address', value: 'zoomquilt.org' },
    ],
    visits: 73,
    added: '2026-08-04',
    addedLabel: 'Aug 4',
    accent: 'from-[#5b376b] to-[#b06970]',
  },
  {
    slug: 'pointer-pointer',
    name: 'Pointer Pointer',
    externalUrl: 'https://pointerpointer.com/',
    description: 'A photo that points at your cursor, wherever you put it.',
    summary:
      'Leave your cursor still. It finds a photo of someone pointing exactly at it.',
    tags: ['odd', 'useless', 'funny', 'cursor', 'photo', 'weird'],
    categories: ['Pure oddity', 'Photos', 'Cursor'],
    poster: 'RIGHT THERE',
    notes: [
      'A website built around one precise joke. Place your cursor, wait, and a photograph appears with someone pointing toward that spot.',
      'Pick this when you have thirty seconds and want the web to perform one unnecessary trick perfectly.',
    ],
    facts: [
      { label: 'Mode', value: 'Point and wait' },
      { label: 'Input', value: 'Mouse or pointer' },
      { label: 'Address', value: 'pointerpointer.com' },
    ],
    visits: 61,
    added: '2026-08-05',
    addedLabel: 'Aug 5',
    accent: 'from-[#704d3f] to-[#d28f61]',
  },
  {
    slug: 'a-soft-murmur',
    name: 'A Soft Murmur',
    externalUrl: 'https://asoftmurmur.com/',
    description: 'Mix sounds like rain and waves on separate sliders.',
    summary:
      'Mix rain, waves, wind, and cafe noise into your own ambient backdrop.',
    tags: ['listen', 'sound', 'ambient', 'calm', 'focus', 'rain', 'noise'],
    categories: ['Listen', 'Ambient', 'Calm'],
    poster: 'MIX WEATHER',
    notes: [
      'An ambient sound mixer with separate controls for natural and everyday noises. Raise or lower each source until the backdrop feels right.',
      'Pick this when you want steady sound for reading, focusing, or covering a noisy room.',
    ],
    facts: [
      { label: 'Mode', value: 'Listen and mix' },
      { label: 'Input', value: 'Sound controls' },
      { label: 'Address', value: 'asoftmurmur.com' },
    ],
    visits: 48,
    added: '2026-08-06',
    addedLabel: 'Aug 6',
    accent: 'from-[#42687c] to-[#8ca8aa]',
  },
  {
    slug: 'the-useless-web',
    name: 'The Useless Web',
    externalUrl: 'https://theuselessweb.com/',
    description: 'Sends you to a random website that has no reason to exist.',
    summary: 'A single button that sends you somewhere gloriously pointless.',
    tags: ['odd', 'useless', 'random', 'funny', 'weird', 'surprise'],
    categories: ['Pure oddity', 'Random', 'Surprise'],
    poster: 'WHY NOT?',
    notes: [
      'A launch button for websites with no practical purpose. Press it and the next destination is chosen for you.',
      'Pick this when choosing the rabbit hole is less interesting than being thrown into one.',
    ],
    facts: [
      { label: 'Mode', value: 'Random discovery' },
      { label: 'Input', value: 'One button' },
      { label: 'Address', value: 'theuselessweb.com' },
    ],
    visits: 39,
    added: '2026-08-07',
    addedLabel: 'Aug 7',
    accent: 'from-[#8d3b2b] to-[#d37237]',
  },
]

export const recentFilings: RecentFiling[] = [
  {
    name: 'The Museum of Anything',
    url: 'https://museumofanything.com/',
    description: "A strange museum full of things that don't fit together.",
    tags: ['museum', 'odd'],
    date: 'Aug 6',
  },
  {
    name: 'Neonflames',
    url: 'https://www.neonflames.com/',
    description: 'Paint with glowing colors on a black canvas.',
    tags: ['art', 'drawing'],
    date: 'Aug 4',
  },
  {
    name: 'Windows 93',
    url: 'https://www.windows93.net/',
    description: 'A ridiculous fake operating system.',
    tags: ['odd', 'interactive'],
    date: 'Aug 1',
  },
]

export function getSite(slug: string, entries = sites) {
  return entries.find((site) => site.slug === slug)
}

export function getAdjacentSites(slug: string, entries = sites) {
  const index = entries.findIndex((site) => site.slug === slug)
  const safeIndex = index < 0 ? 0 : index

  return {
    previous: entries[(safeIndex - 1 + entries.length) % entries.length],
    next: entries[(safeIndex + 1) % entries.length],
  }
}
