import type { JojoAuthClient } from "./client";
import type { Profile, UpdateProfileInput } from "./types";

interface ProfileRepository {
  getOrCreate: (userId: string) => Promise<Profile>;
  update: (userId: string, input: UpdateProfileInput) => Promise<Profile>;
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

  const update = async (
    userId: string,
    { displayName, avatarPath }: UpdateProfileInput,
  ): Promise<Profile> => {
    const values = {
      id: userId,
      display_name: displayName.trim() || null,
      ...(avatarPath !== undefined ? { avatar_path: avatarPath } : {}),
    };
    const { data, error } = await client.from("profiles").upsert(values).select("*").single();
    if (error) throw error;
    return data;
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
      .upsert({ id: userId, avatar_path: path })
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

  return { getOrCreate, update, uploadAvatar };
}
