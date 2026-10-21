import UploadFileIcon from '@mui/icons-material/UploadFileOutlined'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

type Props = { label: string; button: string; file: File | null; onChange: (file: File | null) => void; accept?: string }

export function FileField({ label, button, file, onChange, accept }: Props) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} sx={{ flexShrink: 0 }}>
        {button}
        <input type="file" hidden aria-label={label} accept={accept} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      </Button>
      <Typography variant="body2" color={file ? undefined : 'text.secondary'} noWrap>{file ? file.name : label}</Typography>
    </Stack>
  )
}
