// Server-side geo, decided before any script loads.
// Sets a readable cookie the consent logic uses to choose opt-in vs opt-out.
export default async (request, context) => {
  const country = (context.geo && context.geo.country && context.geo.country.code) || '';
  const response = await context.next();

  const type = response.headers.get('content-type') || '';
  if (type.includes('text/html')) {
    response.headers.append(
      'Set-Cookie',
      `caa_geo=${country}; Path=/; Max-Age=86400; SameSite=Lax`
    );
  }
  return response;
};

export const config = { path: '/*' };
