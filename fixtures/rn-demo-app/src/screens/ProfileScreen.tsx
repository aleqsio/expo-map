import { useRef } from 'react'
import { Button, View } from 'react-native'
import BottomSheet from '@gorhom/bottom-sheet'

export default function ProfileScreen() {
  const sheet = useRef<BottomSheet>(null)
  return (
    <View>
      <Button title="Options" onPress={() => sheet.current?.expand()} />
      <BottomSheet ref={sheet} index={-1} snapPoints={['25%', '60%']} />
    </View>
  )
}
