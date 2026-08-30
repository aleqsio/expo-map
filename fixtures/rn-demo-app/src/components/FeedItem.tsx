import { Pressable, Text } from 'react-native'
import { useNavigation } from '@react-navigation/native'

// The link lives in the list item, not in the screen — the parser has to follow
// one import hop to find it.
export function FeedItem({ userId }: { userId: string }) {
  const navigation = useNavigation()
  return (
    <Pressable onPress={() => navigation.navigate('Profile', { userId })}>
      <Text>Open profile</Text>
    </Pressable>
  )
}
