export async function grab(url: string) {
  const res = await fetch(url);
  return res.json();
}
