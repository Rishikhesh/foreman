export const db = {
  async session(id: string) {
    return { id, userId: "u1" }
  },
  user(id: string) {
    return { id, name: "Ada" }
  },
}
