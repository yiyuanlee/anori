import { detectGamut, type Mode } from "@anori/design-system/color-engine";
import { Button as DSButton } from "@anori/design-system/components/Button/Button";
import { Checkbox } from "@anori/design-system/components/Checkbox/Checkbox";
import { Field } from "@anori/design-system/components/Field/Field";
import { Heading } from "@anori/design-system/components/Heading/Heading";
import { Hint } from "@anori/design-system/components/Hint/Hint";
import { HueChromaPicker } from "@anori/design-system/components/HueChromaPicker/HueChromaPicker";
import { Select } from "@anori/design-system/components/Select/Select";
import { Slider } from "@anori/design-system/components/Slider/Slider";
import { assertValue } from "@anori/utils/asserts";
import { showOpenFilePicker } from "@anori/utils/files";
import { useMirrorStateToRef, useRunAfterNextRender } from "@anori/utils/hooks";
import { guid } from "@anori/utils/misc";
import { setPageBackground } from "@anori/utils/page";
import { anoriSchema, type CustomTheme, getAnoriStorage } from "@anori/utils/storage";
import { useStorageValue } from "@anori/utils/storage-lib";
import {
  applyTheme,
  applyThemeColors,
  applyThemeDecorations,
  deleteLightThemeBackground,
  getThemeBackground,
  getThemeBackgroundOriginal,
  type PartialCustomTheme,
  resolveColorScheme,
  saveThemeBackground,
} from "@anori/utils/user-data/theme";
import { useCurrentTheme } from "@anori/utils/user-data/theme-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { css } from "styled-system/css";

const PREVIEW_MODES: Mode[] = ["light", "dark"];
const PREVIEW_MODE_LABEL_KEY: Record<Mode, string> = {
  light: "settings.theme.colorSchemeLight",
  dark: "settings.theme.colorSchemeDark",
};

const editorPanel = css({ display: "flex", flexDirection: "column", gap: "4" });
const preview = css({
  position: "relative",
  overflow: "hidden",
  height: "160px",
  borderRadius: "md",
  // Tiny checkerboard placeholder, shown until an image is selected.
  background: "repeating-conic-gradient(var(--ds-frosted-strong) 0% 25%, transparent 0% 50%) 50% / 18px 18px",
});

const previewImage = css({ position: "absolute", backgroundSize: "cover", backgroundPosition: "center" });
const backgroundSection = css({ display: "flex", flexDirection: "column", gap: "2" });
const editorActions = css({ display: "flex", justifyContent: "flex-end", gap: "3" });

const captureStillFrame = async (image: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(image);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  assertValue(ctx, "couldn't get 2D context from canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("couldn't export still frame"))), "image/png");
  });
};

const useObjectUrlCleanup = (url: string | null) => {
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
};

export const ThemeEditor = ({ theme: themeFromProps, onClose }: { theme?: CustomTheme; onClose: VoidFunction }) => {
  const loadBackground = async () => {
    const files = await showOpenFilePicker(false, ".jpg,.jpeg,.png,.gif");
    if (!files[0]) return;
    const background = files[0];
    backgroundPickedRef.current[previewMode] = true;
    setOriginalBackground(background, previewMode);
    await applyBlur(theme.blur, previewMode);
  };

  const applyBlur = useCallback(async (blur: number, mode: Mode) => {
    const original = originalBackgroundBlob.current[mode];
    if (!original) return;
    const generation = ++blurGenerationRef.current[mode];
    if (blur === 0) {
      blurredBackgroundBlob.current[mode] = original;
      const url = URL.createObjectURL(original);
      setBackgroundUrls((prev) => ({ ...prev, [mode]: url }));
      if (previewModeRef.current === mode || (mode === "dark" && !originalBackgroundBlob.current.light)) {
        setPageBackground(url);
      }
      return;
    }
    setBakingCount((count) => count + 1);
    let img: ImageBitmap | null = null;
    try {
      img = await createImageBitmap(original);
      const PADDING = blur * 2;
      const canvas = document.createElement("canvas");
      canvas.width = img.width + PADDING * 2;
      canvas.height = img.height + PADDING * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error(`couldn't get 2D context from canvas`);
      }
      ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const croppedCanvas = document.createElement("canvas");
      croppedCanvas.width = img.width;
      croppedCanvas.height = img.height;
      const croppedCtx = croppedCanvas.getContext("2d");
      if (!croppedCtx) {
        throw new Error(`couldn't get 2D context from canvas`);
      }
      croppedCtx.drawImage(canvas, PADDING, PADDING, img.width, img.height, 0, 0, img.width, img.height);

      const blob = await new Promise<Blob>((resolve, reject) => {
        croppedCanvas.toBlob((result) => (result ? resolve(result) : reject(new Error("couldn't export background"))), "image/png");
      });
      if (generation !== blurGenerationRef.current[mode]) return;
      blurredBackgroundBlob.current[mode] = blob;
      const url = URL.createObjectURL(blob);
      setBackgroundUrls((prev) => ({ ...prev, [mode]: url }));
      if (previewModeRef.current === mode || (mode === "dark" && !originalBackgroundBlob.current.light)) {
        setPageBackground(url);
      }
    } finally {
      img?.close();
      setBakingCount((count) => count - 1);
    }
  }, []);

  const applyPreview = (accent = theme.accent) => {
    runAfterRender(() => applyThemeColors(accent, previewMode));
  };

  const saveTheme = async () => {
    const id = theme.name;
    const hasBlobs = !!originalBackgroundBlob.current.dark && !!blurredBackgroundBlob.current.dark;
    if (!themeFromProps && !hasBlobs) return;

    const backgroundChanged = !themeFromProps || backgroundPickedRef.current.dark;
    const blurChanged = themeFromProps != null && theme.blur !== themeFromProps.blur;
    if (backgroundChanged && originalBackgroundBlob.current.dark && blurredBackgroundBlob.current.dark) {
      await saveThemeBackground(id, "original", originalBackgroundBlob.current.dark);
      await saveThemeBackground(id, "blurred", blurredBackgroundBlob.current.dark);
    } else if (blurChanged && blurredBackgroundBlob.current.dark) {
      await saveThemeBackground(id, "blurred", blurredBackgroundBlob.current.dark);
    }
    if (originalBackgroundBlob.current.light && blurredBackgroundBlob.current.light) {
      if (backgroundPickedRef.current.light) {
        await saveThemeBackground(id, "light-original", originalBackgroundBlob.current.light);
      }
      if (backgroundPickedRef.current.light || blurChanged) {
        await saveThemeBackground(id, "light-blurred", blurredBackgroundBlob.current.light);
      }
    } else if (themeFromProps?.lightBackground) {
      await deleteLightThemeBackground(id);
    }

    const toSave: CustomTheme = {
      name: theme.name,
      type: "custom",
      blur: theme.blur,
      accent: theme.accent,
      hideDotPattern: theme.hideDotPattern,
      pixelatedBackground: theme.pixelatedBackground,
      lightBackground: !!originalBackgroundBlob.current.light || undefined,
    };
    const storage = await getAnoriStorage();
    let customThemes = storage.get(anoriSchema.customThemes);
    if (themeFromProps) {
      customThemes = customThemes.map((t) => (t.name === id ? toSave : t));
    } else {
      customThemes.push(toSave);
    }
    await storage.set(anoriSchema.customThemes, customThemes);
    savedRef.current = true;
    setCurrentTheme(theme.name);
    await applyTheme(toSave, resolveColorScheme(colorScheme));
    onClose();
  };

  const [colorScheme] = useStorageValue(anoriSchema.colorScheme);
  const [previewMode, setPreviewMode] = useState<Mode>("dark");
  const previewModeRef = useMirrorStateToRef(previewMode);
  const [currentTheme, setCurrentTheme] = useCurrentTheme();
  const currentThemeRef = useMirrorStateToRef(currentTheme);
  const colorSchemeRef = useMirrorStateToRef(colorScheme);
  const savedRef = useRef(false);
  const gamut = useMemo(() => detectGamut(), []);

  // The editor previews colors/background by mutating CSS variables and the page background directly.
  // Restore the user's actual theme whenever the editor is left without saving.
  useEffect(() => {
    return () => {
      if (!savedRef.current) applyTheme(currentThemeRef.current, resolveColorScheme(colorSchemeRef.current));
    };
  }, []);

  const [theme, setTheme] = useState<PartialCustomTheme>(() => {
    if (themeFromProps) return themeFromProps;
    return {
      name: guid(),
      type: "custom",
      blur: 5,
      accent: currentTheme.accent,
    };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: load + bake once per theme; later blur changes bake via the slider's onCommit, not every drag
  useEffect(() => {
    const main = async () => {
      if (!themeFromProps) return;
      try {
        const original = await getThemeBackgroundOriginal(theme.name);
        setOriginalBackground(original, "dark");
        await applyBlur(theme.blur, "dark");
        if (themeFromProps.lightBackground) {
          const lightOriginal = await getThemeBackground(theme.name, "light-original");
          setOriginalBackground(lightOriginal, "light");
          await applyBlur(theme.blur, "light");
        }
      } catch (err) {
        console.log("Error while trying to load background", err);
      }
    };

    main();
  }, [applyBlur, theme.name, themeFromProps]);

  const { t } = useTranslation();
  const originalBackgroundBlob = useRef<Record<Mode, Blob | null>>({ dark: null, light: null });
  const blurredBackgroundBlob = useRef<Record<Mode, Blob | null>>({ dark: null, light: null });
  const backgroundPickedRef = useRef<Record<Mode, boolean>>({ dark: false, light: false });
  const blurGenerationRef = useRef<Record<Mode, number>>({ dark: 0, light: 0 });
  const [bakingCount, setBakingCount] = useState(0);
  const [backgroundUrls, setBackgroundUrls] = useState<Record<Mode, string | null>>({ dark: null, light: null });
  const [originalUrls, setOriginalUrls] = useState<Record<Mode, string | null>>({ dark: null, light: null });
  const [stillFrameUrls, setStillFrameUrls] = useState<Record<Mode, string | null>>({ dark: null, light: null });
  useObjectUrlCleanup(backgroundUrls.dark);
  useObjectUrlCleanup(backgroundUrls.light);
  useObjectUrlCleanup(originalUrls.dark);
  useObjectUrlCleanup(originalUrls.light);
  useObjectUrlCleanup(stillFrameUrls.dark);
  useObjectUrlCleanup(stillFrameUrls.light);

  const setOriginalBackground = (background: Blob, mode: Mode) => {
    originalBackgroundBlob.current[mode] = background;
    setOriginalUrls((prev) => ({ ...prev, [mode]: URL.createObjectURL(background) }));
    setStillFrameUrls((prev) => ({ ...prev, [mode]: null }));
    captureStillFrame(background)
      .then((frame) => {
        if (originalBackgroundBlob.current[mode] === background) {
          setStillFrameUrls((prev) => ({ ...prev, [mode]: URL.createObjectURL(frame) }));
        }
      })
      .catch((err) => console.log("Error while capturing still frame of background", err));
  };

  // The preview box is far smaller than the full-screen background, so the same px blur reads much
  // stronger here than the baked image does behind the page. Scale the live CSS blur by the box's
  // width relative to the viewport (both cover) so the preview approximates the real background.
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const update = () => setPreviewScale(el.clientWidth / window.innerWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const accentRef = useMirrorStateToRef(theme.accent);
  const backgroundUrlsRef = useMirrorStateToRef(backgroundUrls);
  // Flipping the color scheme makes the global theme watcher re-apply the *active* theme; re-assert
  // the editor's draft preview so the in-progress accent (and background) isn't lost. Refs keep this
  // tied to scheme changes only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: colorScheme is the trigger, not a read value — everything is read via refs so this fires on scheme changes only
  useEffect(() => {
    applyThemeColors(accentRef.current, previewModeRef.current);
    const url = backgroundUrlsRef.current[previewModeRef.current] ?? backgroundUrlsRef.current.dark;
    if (url) setPageBackground(url);
  }, [colorScheme]);

  const runAfterRender = useRunAfterNextRender();
  const previewBlur = theme.blur * previewScale;
  const displayedMode = originalUrls[previewMode] ? previewMode : "dark";
  const originalUrl = originalUrls[displayedMode];
  const stillFrameUrl = stillFrameUrls[displayedMode];

  return (
    <div className={editorPanel}>
      <Heading level={3}>{themeFromProps ? t("settings.theme.editTheme") : t("settings.theme.newTheme")}</Heading>

      <Field label={t("settings.theme.previewColorScheme")}>
        <Select<Mode>
          options={PREVIEW_MODES}
          value={previewMode}
          onChange={(mode) => {
            setPreviewMode(mode);
            applyThemeColors(theme.accent, mode);
            const url = backgroundUrls[mode] ?? backgroundUrls.dark;
            if (url) setPageBackground(url);
          }}
          getOptionKey={(m) => m}
          getOptionLabel={(m) => t(PREVIEW_MODE_LABEL_KEY[m])}
        />
      </Field>

      <Field label={t(previewMode === "light" ? "settings.theme.lightBackground" : "settings.theme.darkBackground")}>
        <div className={backgroundSection}>
          <div ref={previewRef} className={preview}>
            {originalUrl && (
              <div
                className={previewImage}
                style={{
                  inset: `-${previewBlur * 2}px`,
                  backgroundImage: `url(${theme.blur > 0 && stillFrameUrl ? stillFrameUrl : originalUrl})`,
                  filter: `blur(${previewBlur}px)`,
                  imageRendering: theme.pixelatedBackground ? "pixelated" : undefined,
                }}
              />
            )}
          </div>

          <DSButton variant="secondary" onClick={loadBackground}>
            {originalUrls[previewMode] ? t("settings.theme.changeBackground") : t("settings.theme.selectBackground")}
          </DSButton>
          {previewMode === "light" && originalUrls.light && (
            <DSButton
              variant="secondary"
              onClick={() => {
                blurGenerationRef.current.light++;
                originalBackgroundBlob.current.light = null;
                blurredBackgroundBlob.current.light = null;
                setOriginalUrls((prev) => ({ ...prev, light: null }));
                setStillFrameUrls((prev) => ({ ...prev, light: null }));
                setBackgroundUrls((prev) => ({ ...prev, light: null }));
                if (backgroundUrls.dark) setPageBackground(backgroundUrls.dark);
              }}
            >
              {t("settings.theme.useDarkBackground")}
            </DSButton>
          )}
        </div>
      </Field>

      <Field label={t("settings.theme.blur")}>
        <Slider
          value={theme.blur}
          min={0}
          max={50}
          onChange={(val) => setTheme((p) => ({ ...p, blur: val }))}
          onCommit={(val) => {
            applyBlur(val, "dark");
            if (originalBackgroundBlob.current.light) applyBlur(val, "light");
          }}
        />
      </Field>

      <HueChromaPicker
        label={t("settings.theme.colorAccent")}
        value={theme.accent}
        mode={previewMode}
        gamut={gamut}
        onChange={(accent) => {
          setTheme((p) => ({ ...p, accent }));
          applyPreview(accent);
        }}
      />

      <Checkbox
        checked={!!theme.hideDotPattern}
        onChange={(v) => {
          setTheme((p) => ({ ...p, hideDotPattern: v }));
          applyThemeDecorations({ ...theme, hideDotPattern: v });
        }}
      >
        {t("settings.theme.hideDotPattern")}
      </Checkbox>

      <Checkbox
        checked={!!theme.pixelatedBackground}
        onChange={(v) => {
          setTheme((p) => ({ ...p, pixelatedBackground: v }));
          applyThemeDecorations({ ...theme, pixelatedBackground: v });
        }}
      >
        {t("settings.theme.pixelatedBackground")} <Hint content={t("settings.theme.pixelatedBackgroundHint")} />
      </Checkbox>

      <div className={editorActions}>
        <DSButton variant="secondary" onClick={onClose}>
          {t("back")}
        </DSButton>
        <DSButton disabled={!backgroundUrls.dark || bakingCount > 0} onClick={saveTheme}>
          {t("save")}
        </DSButton>
      </div>
    </div>
  );
};
