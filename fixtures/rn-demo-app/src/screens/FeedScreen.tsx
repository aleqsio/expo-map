import { View } from 'react-native'
import { FeedItem } from '@/components/FeedItem'

export default function FeedScreen() {
  return (
    <View>
      <FeedItem userId="42" />
    </View>
  )
}
