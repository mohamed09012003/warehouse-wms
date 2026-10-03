// Auth.js (next-auth v5) configuration: AUTHENTICATION only (who is this user?).
// Authorization (which organization, which permissions) is resolved per request by the
// tenancy module from the database; nothing about organizations is stored in the token.
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authenticateWithPassword } from "@/modules/identity";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Credentials provider requires JWT sessions. The JWT carries only the user id.
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => authenticateWithPassword(credentials),
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (typeof token.uid === "string") session.user.id = token.uid;
      return session;
    },
  },
});
