/** A stylesheet imported `with { type: "text" }` is its text: the build inlines it into both pages as written. */
declare module "*.css" {
  const text: string;
  export default text;
}
