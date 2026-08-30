import { Button, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'

export default function SearchScreen() {
  const navigation = useNavigation()
  return (
    <View>
      <Button title="Settings" onPress={() => navigation.navigate('Settings')} />
    </View>
  )
}
