export const read = (path: string) => Bun.file(path).text();
