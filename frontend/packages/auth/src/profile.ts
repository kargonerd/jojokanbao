import type { JojoAuthClient } from "./client";
import type { Profile } from "./types";

interface ProfileRepository {
  getOrCreate: (userId: string, signal?: AbortSignal) => Promise<Profile>;
}

export function createProfileRepository(client: JojoAuthClient): ProfileRepository {
  const getOrCreate = async (userId: string, signal?: AbortSignal): Promise<Profile> => {
    const query = client.from("profiles").select("*").eq("id", userId);
    if (signal) query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (data) return data;
    if (signal?.aborted) throw new Error("Profile request cancelled");

    const insert = client
      .from("profiles")
      .insert({ id: userId })
      .select("*");
    if (signal) insert.abortSignal(signal);
    const { data: created, error: createError } = await insert.single();
    if (createError) throw createError;
    return created;
  };

  return { getOrCreate };
}
