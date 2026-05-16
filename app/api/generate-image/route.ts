import { countGenerationsSince, createGeneration, utcMonthStart } from "@/db/generations";
import { getMonthlyGenerationLimit } from "@/lib/generation-quota";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import sharp from "sharp";

import * as Sentry from "@sentry/nextjs";
import { openaiProvider } from "@/lib/openai";
import { ACCEPTED_SOURCE_IMAGE_MIME_TYPES } from "@/lib/constants";
import { getStylePreset } from "@/lib/style-presets";

import { APICallError, generateImage, NoImageGeneratedError } from "ai";
import { uploadBufferToImageKit } from "@/lib/imagekit";

export const runtime = "nodejs";

type EditImageSize = "1024x1024" | "1536x1024" | "1024x1536";

type GenerateImageRequest = {
  sourceImageUrl?: string;
  sourceMimeType?: string;
  originalFileName?: string;
  styleSlug?: string;
  model?: string;
};

/**
 * inferImageSize reads width and height from the uploaded image (via sharp), computes aspect ratio,
 * and returns one of the allowed `size` values for OpenAI image edits.
 */
async function inferImageSize(imageBuffer: Buffer): Promise<EditImageSize> {
  try {
    const metadata = await sharp(imageBuffer).metadata();

    if (!metadata.width || !metadata.height) {
      return "1024x1024";
    }

    const aspectRatio = metadata.width / metadata.height;

    if (aspectRatio > 1.08) return "1536x1024"; // this means that the input image is wider than it is tall
    if (aspectRatio < 0.92) return "1024x1536"; // this means that the input image is taller than it is wide
    return "1024x1024"; // this means that the input image is square
  } catch {
    return "1024x1024";
  }
}

export async function POST(request: Request) {
  const { userId, has } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const monthlyLimit = getMonthlyGenerationLimit(has);
  const usedThisMonth = await countGenerationsSince(userId, utcMonthStart());

  if (usedThisMonth >= monthlyLimit) {
    Sentry.logger.warn("generation.quota_exceeded", {
      limit: monthlyLimit,
      used: usedThisMonth,
    });

    return NextResponse.json(
      {
        error: `Monthly generation limit reached (${monthlyLimit} images). Upgrade your plan or try again next month.`,
        code: "QUOTA_EXCEEDED" as const,
        limit: monthlyLimit,
        used: usedThisMonth,
      },
      { status: 429 },
    );
  }

  if (!openaiProvider) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }

  const body = (await request.json()) as GenerateImageRequest;

  const { model, originalFileName, sourceImageUrl, sourceMimeType, styleSlug } = body;

  if (!sourceImageUrl) {
    return NextResponse.json({ error: "Please upload an image first." }, { status: 400 });
  }

  if (typeof sourceMimeType !== "string" || !ACCEPTED_SOURCE_IMAGE_MIME_TYPES.has(sourceMimeType)) {
    return NextResponse.json(
      { error: "Only JPG, PNG, and WEBP files are supported." },
      { status: 400 },
    );
  }

  if (typeof styleSlug !== "string") {
    return NextResponse.json({ error: "Please choose a style." }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ error: "Please choose a model." }, { status: 400 });
  }

  const preset = getStylePreset(styleSlug);
  if (!preset) {
    return NextResponse.json({ error: "Unknown style preset." }, { status: 400 });
  }

  const imageResponse = await fetch(sourceImageUrl);
  if (!imageResponse.ok) {
    return NextResponse.json(
      { error: "Could not fetch the uploaded source image." },
      { status: 404 },
    );
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const imageSize = await inferImageSize(imageBuffer);

  const prompt = [
    preset.prompt,
    "Do not add extra people, extra limbs, duplicate subjects, or change the overall camera angle.",
  ].join("\n\n");

  try {
    // Manual gen_ai instrumentation: the Vercel AI integration auto-instruments
    // generateText/streamText (when experimental_telemetry is enabled), but not
    // generateImage. Span attributes follow the Sentry gen_ai conventions:
    // https://getsentry.github.io/sentry-conventions/attributes/gen_ai/
    //
    // Note: input messages contain the user-supplied prompt text. This is
    // intentional and matches the wider sendDefaultPii: true configuration —
    // do not include raw image bytes (Sentry attributes only accept primitives).
    const inputMessages = [
      { role: "user", parts: [{ type: "text", content: prompt }] },
      {
        role: "user",
        parts: [
          {
            type: "image",
            content: `[source image omitted; mime=${sourceMimeType}, size=${imageSize}]`,
          },
        ],
      },
    ];

    const result = await Sentry.startSpan(
      {
        name: `generate_content ${model}`,
        op: "gen_ai.generate_content",
        attributes: {
          "gen_ai.request.model": model,
          "gen_ai.operation.name": "generate_content",
          "gen_ai.system": "openai",
          "gen_ai.input.messages": JSON.stringify(inputMessages),
        },
      },
      async (span) => {
        const out = await generateImage({
          model: openaiProvider!.imageModel(model),
          prompt: {
            images: [imageBuffer],
            text: prompt,
          },
          size: imageSize,
          providerOptions: {
            openai: {
              input_fidelity: "high", // input image is used as a reference for the generation
              quality: "medium",
              output_format: "png",
              user: userId,
            },
          },
        });

        const u = out.usage;

        if (u.inputTokens != null) {
          span.setAttribute("gen_ai.usage.input_tokens", u.inputTokens);
        }
        if (u.outputTokens != null) {
          span.setAttribute("gen_ai.usage.output_tokens", u.outputTokens);
        }
        if (u.totalTokens != null) {
          span.setAttribute("gen_ai.usage.total_tokens", u.totalTokens);
        }

        const outputMessages = [
          {
            role: "assistant",
            parts: [
              {
                type: "image",
                content: "[image/png generated; pixel data not sent to Sentry]",
              },
            ],
            finish_reason: "stop",
          },
        ];
        span.setAttribute("gen_ai.output.messages", JSON.stringify(outputMessages));

        return out;
      },
    );

    const imageBase64 = result.image.base64;

    const resultBuffer = Buffer.from(imageBase64, "base64");

    const { url: resultImageUrl } = await uploadBufferToImageKit({
      buffer: resultBuffer,
      fileName: `${preset.slug}-result.png`,
      folder: `/users/${userId}/results`,
      mimeType: "image/png",
    });

    const savedGeneration = await createGeneration({
      clerkUserId: userId,
      originalFileName: typeof originalFileName === "string" ? originalFileName : null,
      sourceImageUrl,
      resultImageUrl,
      styleSlug: preset.slug,
      styleLabel: preset.label,
      model,
      promptUsed: prompt,
    });

    Sentry.logger.info("generation.completed", {
      generationId: savedGeneration.id,
      styleSlug: preset.slug,
      model,
    });

    return NextResponse.json({
      imageBase64,
      mimeType: "image/png",
      promptUsed: prompt,
      style: { slug: preset.slug, label: preset.label },
      model,
      savedGeneration,
    });
  } catch (error) {
    console.error("generate-image route failed", error);

    if (APICallError.isInstance(error)) {
      return NextResponse.json(
        { error: error.message || "Image generation failed. Please try again." },
        { status: error.statusCode ?? 500 },
      );
    }

    if (NoImageGeneratedError.isInstance(error)) {
      return NextResponse.json({ error: "The model did not return an image." }, { status: 502 });
    }

    return NextResponse.json(
      { error: "Image generation failed. Please try again." },
      { status: 500 },
    );
  }
}