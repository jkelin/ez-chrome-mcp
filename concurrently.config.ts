import concurrently from "concurrently";

const { result } = concurrently(
  [
    {
      command: "bun run watch",
      name: "watch",
      prefixColor: "blue",
    },
    {
      command: "bun run inspector",
      name: "inspector",
      prefixColor: "magenta",
    },
  ],
  {
    prefix: "name",
    killOthersOn: ["failure"],
    successCondition: "all",
  },
);

try {
  await result;
} catch {
  // Concurrently already prints the failing command output; avoid dumping full process objects.
  process.exit(1);
}
