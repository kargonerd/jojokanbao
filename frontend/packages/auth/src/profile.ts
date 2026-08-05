import type { JojoAuthClient } from "./client";
import type { Profile } from "./types";

interface ProfileRepository {
  getOrCreate: (userId: string) => Promise<Profile>;
  uploadAvatar: (userId: string, previousPath: string | null, file: File) => Promise<Profile>;
}

export function createProfileRepository(client: JojoAuthClient): ProfileRepository {
  const getOrCreate = async (userId: string): Promise<Profile> => {
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw error;
    if (data) return data;

    const { data: created, error: createError } = await client
      .from("profiles")
      .insert({ id: userId })
      .select("*")
      .single();
    if (createError) throw createError;
    return created;
  };

  const uploadAvatar = async (
    userId: string,
    previousPath: string | null,
    file: File,
  ): Promise<Profile> => {
    const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `${userId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await client.storage.from("avatars").upload(path, file, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) throw uploadError;

    const { data, error } = await client
      .from("profiles")
      .update({ avatar_path: path })
      .eq("id", userId)
      .select("*")
      .single();
    if (error) {
      await client.storage.from("avatars").remove([path]);
      throw error;
    }

    if (previousPath) {
      await client.storage.from("avatars").remove([previousPath]);
    }
    return data;
  };

  return { getOrCreate, uploadAvatar };
}
