import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const t0 = Date.now();
  try {
    const body = await request.json();
    const { url, method, headers, requestBody } = body;

    if (!url || !method) {
      return NextResponse.json(
        { error: 'url and method are required' },
        { status: 400 }
      );
    }

    // Prepare fetch options
    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: headers || {},
    };

    if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD' && requestBody) {
      fetchOptions.body = requestBody;
    }

    const response = await fetch(url, fetchOptions);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Try to parse JSON response if possible, otherwise text
    let data: unknown;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        data = await response.text();
      }
    } else {
      data = await response.text();
    }

    const t1 = Date.now();

    return NextResponse.json({
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
      time: t1 - t0,
    });
  } catch (error) {
    const t1 = Date.now();
    console.error('Proxy Error:', error);
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : 'Failed to proxy request',
        status: 500,
        time: t1 - t0
      },
      { status: 500 }
    );
  }
}
