export default {
  fetch(request) {
    const url = new URL(request.url)
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '60',
      'X-Robots-Tag': 'noindex',
    }
    if (url.pathname === '/health') {
      return Response.json(
        { status: 'maintenance', environment: 'production' },
        { status: 503, headers },
      )
    }
    return Response.json(
      { error: 'Oddweb is briefly unavailable for database maintenance.' },
      { status: 503, headers },
    )
  },
}
