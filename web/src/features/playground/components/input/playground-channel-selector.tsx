/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useQuery } from '@tanstack/react-query'
import { LayersIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { MultiSelect, type Option } from '@/components/multi-select'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getChannels } from '@/features/channels/api'
import type { Channel } from '@/features/channels/types'
import { useIsMobile } from '@/hooks/use-mobile'

import type { PlaygroundConfig } from '../../types'

type PlaygroundChannelSelectorProps = {
  config: PlaygroundConfig
  disabled?: boolean
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
}

function channelToOption(channel: Channel): Option {
  const label = channel.tag
    ? `${channel.name} [${channel.tag}]`
    : channel.name
  return {
    label,
    value: String(channel.id),
  }
}

export function PlaygroundChannelSelector({
  config,
  disabled,
  onConfigChange,
}: PlaygroundChannelSelectorProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const { data: channelsData } = useQuery({
    queryKey: ['playground-channels'],
    queryFn: () => getChannels({ page_size: 1000 }),
  })

  const channels = useMemo<Channel[]>(() => {
    if (!channelsData?.success || !channelsData.data) return []
    return channelsData.data.items
  }, [channelsData])

  const channelOptions = useMemo<Option[]>(
    () => channels.map(channelToOption),
    [channels]
  )

  const selectedIds = config.channel_ids.map(String)

  const handleChange = (values: string[]) => {
    const ids = values.map((v) => Number.parseInt(v, 10)).filter((n) => !Number.isNaN(n))
    onConfigChange('channel_ids', ids)
  }

  const activeCount = config.channel_ids.length

  const trigger = (
    <PromptInputButton
      aria-label={t('Channels')}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 relative font-medium'
      disabled={disabled}
      variant='ghost'
    >
      <LayersIcon size={16} />
      {activeCount > 0 && (
        <span className='bg-primary text-primary-foreground absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-semibold'>
          {activeCount}
        </span>
      )}
    </PromptInputButton>
  )

  const content = (
    <div className='space-y-3 p-1'>
      <div className='space-y-1 px-1'>
        <div className='text-sm font-semibold'>{t('Channel selection')}</div>
        <div className='text-muted-foreground text-xs leading-4'>
          {t('Select channels to use. When empty, the default routing logic is used.')}
        </div>
      </div>
      <MultiSelect
        options={channelOptions}
        selected={selectedIds}
        onChange={handleChange}
        placeholder={t('Select channels...')}
        disabled={disabled}
        maxVisibleChips={3}
      />
      {activeCount > 0 && (
        <div className='flex items-center justify-end px-1'>
          <Badge variant='secondary' className='text-xs'>
            {t('{{count}} channels selected', { count: activeCount })}
          </Badge>
        </div>
      )}
    </div>
  )

  if (isMobile) {
    return (
      <Sheet>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Channels')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Channel selection')}</SheetTitle>
          </SheetHeader>
          <div className='px-4 pb-4'>{content}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Channels')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='w-[22rem] max-w-[calc(100vw-2rem)] gap-3 p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
