/** A refusal shown to the person creating or opening the agent. */
export class NuhuoPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NuhuoPolicyError";
  }
}
