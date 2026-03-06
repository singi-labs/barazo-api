import { z } from 'zod/v4'

export const updatePluginSettingsSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.string(), z.number()])
)

export const installPluginSchema = z.object({
  packageName: z
    .string()
    .min(1)
    .regex(
      /^(@barazo\/plugin-[\w-]+|barazo-plugin-[\w-]+)(@[\w.-]+)?$/,
      'Must match @barazo/plugin-* or barazo-plugin-* with optional version'
    ),
})
